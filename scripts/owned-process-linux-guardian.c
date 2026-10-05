#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if !defined(__x86_64__)
#error "owned process guardian is currently supported only on Linux x86_64"
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif

#define RESULT_FD 3
#define CHILD_LIMIT 4096
#define CLEANUP_GRACE_MS 1000
#ifndef CLEANUP_DEADLINE_MS
#define CLEANUP_DEADLINE_MS 6000
#endif
#define POLL_STEP_NS 10000000L
#define PROC_STAT_LIMIT 8192
#define CHILD_LIST_LIMIT 65536
#define PROTOCOL_NAME "soulforge.owned-process-guardian.v1"

typedef struct {
  pid_t pid;
  unsigned long long start_time;
  char state;
  pid_t parent;
} proc_identity;

typedef struct {
  pid_t pid;
  unsigned long long start_time;
  bool term_sent;
  bool kill_sent;
} signalled_child;

static volatile sig_atomic_t stop_signal = 0;
static signalled_child signalled[CHILD_LIMIT];
static size_t signalled_count = 0;
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
static bool test_hide_children_after_target = false;
static bool test_echild_after_waitid = false;
static bool test_pidfd_preflight_failure = false;
static bool test_reaper_churn = false;
static bool test_target_exit_seen = false;
static unsigned int test_reaper_churn_count = 0;
#endif

static void on_stop_signal(int signal_number) {
  if (signal_number == SIGUSR1) stop_signal = 2;
  else if (stop_signal == 0) stop_signal = 1;
}

static long long monotonic_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (long long)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static void short_sleep(void) {
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_STEP_NS };
  while (nanosleep(&pause, &pause) != 0 && errno == EINTR) { }
}

static int write_all(int fd, const void *buffer, size_t length) {
  const unsigned char *cursor = (const unsigned char *)buffer;
  while (length > 0) {
    ssize_t count = write(fd, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    cursor += (size_t)count;
    length -= (size_t)count;
  }
  return 0;
}

static int is_nonce(const char *value) {
  if (!value || strlen(value) != 36) return 0;
  for (size_t index = 0; index < 36; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return 0;
    } else if (!((value[index] >= '0' && value[index] <= '9')
      || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int read_identity(pid_t pid, proc_identity *out) {
  char path[96];
  char raw[PROC_STAT_LIMIT];
  int path_length = snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  if (path_length <= 0 || (size_t)path_length >= sizeof(path)) { errno = EOVERFLOW; return -1; }
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT || errno == ESRCH) return 0;
    return -1;
  }
  ssize_t bytes = read(fd, raw, sizeof(raw) - 1);
  int saved = errno;
  close(fd);
  if (bytes < 0) { errno = saved; return -1; }
  raw[bytes] = '\0';
  char *close_paren = strrchr(raw, ')');
  if (!close_paren) { errno = EPROTO; return -1; }
  char *save = NULL;
  char *token = strtok_r(close_paren + 1, " ", &save);
  int field = 3;
  bool has_state = false, has_parent = false, has_start = false;
  while (token) {
    if (field == 3) { out->state = token[0]; has_state = true; }
    else if (field == 4) {
      char *end = NULL; long value = strtol(token, &end, 10);
      if (!end || *end || value <= 0) { errno = EPROTO; return -1; }
      out->parent = (pid_t)value; has_parent = true;
    } else if (field == 22) {
      char *end = NULL; unsigned long long value = strtoull(token, &end, 10);
      if (!end || *end) { errno = EPROTO; return -1; }
      out->start_time = value; has_start = true; break;
    }
    field++;
    token = strtok_r(NULL, " ", &save);
  }
  if (!has_state || !has_parent || !has_start) { errno = EPROTO; return -1; }
  out->pid = pid;
  return 1;
}

static int read_direct_children(pid_t *output, size_t capacity, size_t *count) {
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
  if (test_hide_children_after_target && test_target_exit_seen) { *count = 0; return 0; }
#endif
  char path[128];
  long tid = syscall(SYS_gettid);
  int length = snprintf(path, sizeof(path), "/proc/self/task/%ld/children", tid);
  if (length <= 0 || (size_t)length >= sizeof(path)) { errno = EOVERFLOW; return -1; }
  FILE *file = fopen(path, "r");
  if (!file) return -1;
  char line[CHILD_LIST_LIMIT];
  if (!fgets(line, sizeof(line), file)) {
    if (ferror(file)) { int saved = errno ? errno : EIO; fclose(file); errno = saved; return -1; }
    line[0] = '\0';
  }
  if (!feof(file) && !strchr(line, '\n')) { fclose(file); errno = EOVERFLOW; return -1; }
  fclose(file);
  size_t used = 0;
  char *save = NULL;
  for (char *token = strtok_r(line, " \t\r\n", &save); token; token = strtok_r(NULL, " \t\r\n", &save)) {
    char *end = NULL; long value = strtol(token, &end, 10);
    if (!end || *end || value <= 0 || used >= capacity) { errno = EOVERFLOW; return -1; }
    output[used++] = (pid_t)value;
  }
  *count = used;
  return 0;
}

static int child_is_listed(pid_t pid, bool *listed) {
  pid_t children[CHILD_LIMIT]; size_t count = 0;
  if (read_direct_children(children, CHILD_LIMIT, &count) != 0) return -1;
  *listed = false;
  for (size_t index = 0; index < count; index++) if (children[index] == pid) { *listed = true; break; }
  return 0;
}

static int find_signal_record(pid_t pid, unsigned long long start_time, bool create, signalled_child **result) {
  for (size_t index = 0; index < signalled_count; index++) {
    if (signalled[index].pid == pid && signalled[index].start_time == start_time) {
      *result = &signalled[index]; return 0;
    }
  }
  if (!create) { *result = NULL; return 0; }
  if (signalled_count >= CHILD_LIMIT) { errno = EOVERFLOW; return -1; }
  signalled_child *record = &signalled[signalled_count++];
  record->pid = pid; record->start_time = start_time; record->term_sent = false; record->kill_sent = false;
  *result = record;
  return 0;
}

/* Open and signal only an identity re-confirmed as this Guardian's direct child. */
static int signal_verified_child(pid_t pid, int signal_number) {
  proc_identity before = {0}, after = {0};
  int found = read_identity(pid, &before);
  if (found == 0) return 0;
  if (found < 0) return -1;
  if (before.state == 'Z' || before.state == 'X') return 0;
  if (before.parent != getpid()) {
    bool listed = false;
    if (child_is_listed(pid, &listed) != 0) return -1;
    if (!listed) return 0;
    errno = ESTALE; return -1;
  }
  int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (pidfd < 0) {
    if (errno == ESRCH || errno == ENOENT) return 0;
    return -1;
  }
  int after_found = read_identity(pid, &after);
  if (after_found == 0) { close(pidfd); return 0; }
  if (after_found < 0) { int saved = errno; close(pidfd); errno = saved; return -1; }
  bool listed = false;
  if (child_is_listed(pid, &listed) != 0) { int saved = errno; close(pidfd); errno = saved; return -1; }
  if (!listed) { close(pidfd); return 0; }
  if (after.parent != getpid() || before.start_time != after.start_time) { close(pidfd); errno = ESTALE; return -1; }
  if (after.state == 'Z' || after.state == 'X') { close(pidfd); return 0; }
  signalled_child *record = NULL;
  if (find_signal_record(pid, after.start_time, true, &record) != 0) { int saved = errno; close(pidfd); errno = saved; return -1; }
  bool *sent = signal_number == SIGTERM ? &record->term_sent : &record->kill_sent;
  if (!*sent) {
    if (syscall(SYS_pidfd_send_signal, pidfd, signal_number, NULL, 0) != 0 && errno != ESRCH) {
      int saved = errno; close(pidfd); errno = saved; return -1;
    }
    *sent = true;
  }
  close(pidfd);
  return 0;
}

/* Inspect only children reparented to this subreaper; return live descendants. */
static int inspect_children(pid_t target_pid, bool target_exited, bool terminating,
    int signal_number, bool *live_descendant) {
  pid_t children[CHILD_LIMIT]; size_t count = 0;
  if (read_direct_children(children, CHILD_LIMIT, &count) != 0) return -1;
  *live_descendant = false;
  for (size_t index = 0; index < count; index++) {
    pid_t pid = children[index];
    if (pid == target_pid) {
      if (!target_exited && terminating && signal_verified_child(pid, signal_number) != 0) return -1;
      continue;
    }
    proc_identity identity = {0};
    int found = read_identity(pid, &identity);
    if (found == 0) continue;
    if (found < 0) return -1;
    if (identity.parent != getpid()) {
      bool listed = false;
      if (child_is_listed(pid, &listed) != 0) return -1;
      if (!listed) continue;
      errno = ESTALE; return -1;
    }
    if (identity.state == 'Z' || identity.state == 'X') continue;
    *live_descendant = true;
    if (terminating && signal_verified_child(pid, signal_number) != 0) return -1;
  }
  return 0;
}

static const char *signal_name(int value) {
  switch (value) {
    case SIGHUP: return "SIGHUP"; case SIGINT: return "SIGINT"; case SIGQUIT: return "SIGQUIT";
    case SIGILL: return "SIGILL"; case SIGABRT: return "SIGABRT"; case SIGFPE: return "SIGFPE";
    case SIGKILL: return "SIGKILL"; case SIGSEGV: return "SIGSEGV"; case SIGPIPE: return "SIGPIPE";
    case SIGALRM: return "SIGALRM"; case SIGTERM: return "SIGTERM"; case SIGUSR1: return "SIGUSR1";
    case SIGUSR2: return "SIGUSR2"; case SIGCHLD: return "SIGCHLD"; case SIGCONT: return "SIGCONT";
    case SIGSTOP: return "SIGSTOP"; case SIGTSTP: return "SIGTSTP"; default: return "SIGUNKNOWN";
  }
}

static int publish_result(const char *nonce, int code, const char *signal, int child_exit_code,
    bool tree_stopped, bool descendants_observed, const char *termination_reason, int spawn_errno) {
  char output[1024], signal_json[32], child_json[32], reason_json[96];
  if (signal) snprintf(signal_json, sizeof(signal_json), "\"%s\"", signal);
  else snprintf(signal_json, sizeof(signal_json), "null");
  if (child_exit_code >= 0) snprintf(child_json, sizeof(child_json), "%d", child_exit_code);
  else snprintf(child_json, sizeof(child_json), "null");
  if (termination_reason) snprintf(reason_json, sizeof(reason_json), "\"%s\"", termination_reason);
  else snprintf(reason_json, sizeof(reason_json), "null");
  int length = snprintf(output, sizeof(output),
    "{\"protocol\":\"%s\",\"nonce\":\"%s\",\"code\":%d,\"signal\":%s,\"childExitCode\":%s,\"treeStopped\":%s,\"descendantsObserved\":%s,\"terminationReason\":%s,\"spawnErrno\":%d}\n",
    PROTOCOL_NAME, nonce, code, signal_json, child_json, tree_stopped ? "true" : "false",
    descendants_observed ? "true" : "false", reason_json, spawn_errno);
  if (length <= 0 || (size_t)length >= sizeof(output)) return -1;
  return write_all(RESULT_FD, output, (size_t)length);
}

static int parse_positive_timeout(const char *value, long long *out) {
  char *end = NULL; errno = 0;
  long long parsed = strtoll(value, &end, 10);
  if (errno || !end || *end || parsed < 0 || parsed > 2147000000) return -1;
  *out = parsed; return 0;
}

static int pidfd_preflight(void) {
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
  if (test_pidfd_preflight_failure) { errno = ENOSYS; return -1; }
#endif
  int pidfd = (int)syscall(SYS_pidfd_open, getpid(), 0);
  if (pidfd < 0) return -1;
  int result = (int)syscall(SYS_pidfd_send_signal, pidfd, 0, NULL, 0);
  int saved = errno; close(pidfd); errno = saved;
  return result;
}

static int reap_specific(pid_t pid, pid_t target, int *target_status, bool *target_reaped) {
  int status = 0;
  pid_t result;
  do { result = waitpid(pid, &status, WNOHANG); } while (result < 0 && errno == EINTR);
  if (result < 0) return -1;
  if (result == 0) return 0;
  if (result == target) { *target_status = status; *target_reaped = true; }
  return 1;
}

#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
static int spawn_reaped_test_child(void) {
  pid_t child = fork();
  if (child < 0) return -1;
  if (child == 0) _exit(0);
  for (;;) {
    siginfo_t info; memset(&info, 0, sizeof(info));
    if (waitid(P_PID, (id_t)child, &info, WEXITED | WNOHANG | WNOWAIT) == 0) {
      if (info.si_pid == child) return 0;
    } else if (errno != EINTR) return -1;
    short_sleep();
  }
}
#endif

static int exit_code_from_status(int status, const char **signal, int *child_exit_code) {
  *signal = NULL;
  *child_exit_code = -1;
  if (WIFEXITED(status)) { *child_exit_code = WEXITSTATUS(status); return *child_exit_code; }
  if (WIFSIGNALED(status)) { *signal = signal_name(WTERMSIG(status)); return 128 + WTERMSIG(status); }
  return 1;
}

int main(int argc, char **argv) {
  const char *nonce = NULL;
  long long timeout_ms = 0;
  int command_index = -1;
  for (int index = 1; index < argc; index++) {
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
    if (strcmp(argv[index], "--test-hide-children-after-target") == 0) { test_hide_children_after_target = true; continue; }
    if (strcmp(argv[index], "--test-echild-after-waitid") == 0) { test_echild_after_waitid = true; continue; }
    if (strcmp(argv[index], "--test-pidfd-preflight-failure") == 0) { test_pidfd_preflight_failure = true; continue; }
    if (strcmp(argv[index], "--test-reaper-churn") == 0) { test_reaper_churn = true; continue; }
#endif
    if (strcmp(argv[index], "--nonce") == 0 && index + 1 < argc) { nonce = argv[++index]; continue; }
    if (strcmp(argv[index], "--timeout-ms") == 0 && index + 1 < argc) {
      if (parse_positive_timeout(argv[++index], &timeout_ms) != 0) return 2;
      continue;
    }
    if (strcmp(argv[index], "--") == 0) { command_index = index + 1; break; }
    return 2;
  }
  if (!is_nonce(nonce) || command_index < 0 || command_index >= argc || !argv[command_index][0]) return 2;

  struct sigaction default_child; memset(&default_child, 0, sizeof(default_child));
  default_child.sa_handler = SIG_DFL; sigemptyset(&default_child.sa_mask);
  if (sigaction(SIGCHLD, &default_child, NULL) != 0) return 3;
  struct sigaction stop_action; memset(&stop_action, 0, sizeof(stop_action));
  stop_action.sa_handler = on_stop_signal; sigemptyset(&stop_action.sa_mask);
  if (sigaction(SIGTERM, &stop_action, NULL) != 0 || sigaction(SIGUSR1, &stop_action, NULL) != 0) return 3;
  signal(SIGPIPE, SIG_IGN);

  int descriptor_flags = fcntl(RESULT_FD, F_GETFD);
  if (descriptor_flags < 0 || fcntl(RESULT_FD, F_SETFD, descriptor_flags | FD_CLOEXEC) != 0) return 3;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0 || pidfd_preflight() != 0) {
    int saved = errno;
    publish_result(nonce, 1, NULL, -1, false, false, "guardian-capability-unavailable", saved);
    return 1;
  }
  pid_t initial_children[CHILD_LIMIT]; size_t initial_count = 0;
  if (read_direct_children(initial_children, CHILD_LIMIT, &initial_count) != 0 || initial_count != 0) {
    int saved = errno ? errno : EBUSY;
    publish_result(nonce, 1, NULL, -1, false, false, "guardian-child-state-unavailable", saved);
    return 1;
  }

  if (stop_signal != 0) {
    publish_result(nonce, 1, NULL, -1, false, false, stop_signal == 1 ? "cancelled" : "timeout", 0);
    return 1;
  }

  int exec_pipe[2];
  if (pipe2(exec_pipe, O_CLOEXEC) != 0) {
    int saved = errno; publish_result(nonce, 1, NULL, -1, false, false, "spawn-error", saved); return 1;
  }
  pid_t target_pid = fork();
  if (target_pid < 0) {
    int saved = errno; close(exec_pipe[0]); close(exec_pipe[1]);
    publish_result(nonce, 1, NULL, -1, false, false, "spawn-error", saved); return 1;
  }
  if (target_pid == 0) {
    close(exec_pipe[0]);
    struct sigaction default_pipe; memset(&default_pipe, 0, sizeof(default_pipe));
    default_pipe.sa_handler = SIG_DFL; sigemptyset(&default_pipe.sa_mask);
    if (sigaction(SIGPIPE, &default_pipe, NULL) != 0) {
      int saved = errno;
      (void)write_all(exec_pipe[1], &saved, sizeof(saved));
      _exit(127);
    }
    execvp(argv[command_index], &argv[command_index]);
    int saved = errno;
    (void)write_all(exec_pipe[1], &saved, sizeof(saved));
    _exit(127);
  }
  close(exec_pipe[1]);
  int spawn_errno = 0;
  ssize_t error_bytes;
  do { error_bytes = read(exec_pipe[0], &spawn_errno, sizeof(spawn_errno)); } while (error_bytes < 0 && errno == EINTR);
  int read_error = errno; close(exec_pipe[0]);
  if (error_bytes < 0) { spawn_errno = read_error ? read_error : EIO; }

  long long started_ms = monotonic_ms();
  if (started_ms < 0) { stop_signal = 2; started_ms = 0; }
  long long deadline_ms = timeout_ms > 0 ? started_ms + timeout_ms : LLONG_MAX;
  long long cleanup_started_ms = -1;
  int target_status = 0;
  long long target_exit_observed_ms = -1;
  bool target_exit_observed = false, target_reaped = false;
  bool descendants_observed = false, tree_stopped = false;
  const char *target_signal = NULL;
  int target_code = -1, child_exit_code = -1;
  const char *termination_reason = NULL;
  bool supervision_failed = false;

  for (;;) {
    long long now = monotonic_ms();
    if (now < 0) { supervision_failed = true; break; }
    if (target_exit_observed_ms >= 0 && now - target_exit_observed_ms > CLEANUP_DEADLINE_MS) {
      supervision_failed = true; break;
    }
    if (stop_signal == 0 && now >= deadline_ms) stop_signal = 2;
    if (stop_signal == 1 || stop_signal == 2) {
      if (cleanup_started_ms < 0) cleanup_started_ms = now;
      termination_reason = stop_signal == 1 ? "cancelled" : "timeout";
    }

    if (!target_exit_observed) {
      siginfo_t info; memset(&info, 0, sizeof(info));
      if (waitid(P_ALL, 0, &info, WEXITED | WNOHANG | WNOWAIT) != 0) {
        if (errno != EINTR && errno != ECHILD) { supervision_failed = true; break; }
        if (errno == ECHILD) { supervision_failed = true; break; }
      } else if (info.si_pid > 0) {
        if (info.si_pid == target_pid) {
          target_exit_observed = true;
          target_exit_observed_ms = now;
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
          test_target_exit_seen = true;
#endif
          bool live_descendant = false;
          if (inspect_children(target_pid, true, false, 0, &live_descendant) != 0) { supervision_failed = true; break; }
          if (live_descendant) {
            descendants_observed = true;
            if (cleanup_started_ms < 0) cleanup_started_ms = now;
            if (!termination_reason) termination_reason = "descendant-leak";
          }
        }
        int reaped;
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
        if (test_echild_after_waitid) { test_echild_after_waitid = false; errno = ECHILD; reaped = -1; }
        else reaped = reap_specific(info.si_pid, target_pid, &target_status, &target_reaped);
#else
        reaped = reap_specific(info.si_pid, target_pid, &target_status, &target_reaped);
#endif
        if (reaped < 0) { supervision_failed = true; break; }
        if (info.si_pid == target_pid && !target_reaped) { supervision_failed = true; break; }
        if (info.si_pid == target_pid) target_code = exit_code_from_status(target_status, &target_signal, &child_exit_code);
        if (info.si_pid != target_pid) { short_sleep(); continue; }
      }
    }

    if (target_reaped) {
      bool live_descendant = false;
      if (inspect_children(target_pid, true, false, 0, &live_descendant) != 0) { supervision_failed = true; break; }
      if (live_descendant) {
        descendants_observed = true;
        if (cleanup_started_ms < 0) cleanup_started_ms = now;
        if (!termination_reason) termination_reason = "descendant-leak";
      }
      if (cleanup_started_ms >= 0) {
        long long elapsed = now - cleanup_started_ms;
        int stop_with = elapsed >= CLEANUP_GRACE_MS ? SIGKILL : SIGTERM;
        bool ignored = false;
        if (inspect_children(target_pid, true, true, stop_with, &ignored) != 0) { supervision_failed = true; break; }
        if (now - cleanup_started_ms > CLEANUP_DEADLINE_MS) { supervision_failed = true; break; }
      }
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
      if (test_reaper_churn) {
        if (spawn_reaped_test_child() != 0) { supervision_failed = true; break; }
        test_reaper_churn_count++;
      }
#endif
      int status = 0; pid_t waited;
      do { waited = waitpid(-1, &status, WNOHANG); } while (waited < 0 && errno == EINTR);
      if (waited > 0) {
        if (waited == target_pid) { target_status = status; target_code = exit_code_from_status(status, &target_signal, &child_exit_code); }
        short_sleep(); continue;
      }
      if (waited < 0 && errno == ECHILD) { tree_stopped = true; break; }
      if (waited < 0) { supervision_failed = true; break; }
      if (waited == 0 && target_exit_observed_ms >= 0
        && now - target_exit_observed_ms > CLEANUP_DEADLINE_MS) { supervision_failed = true; break; }
    }

    if (cleanup_started_ms >= 0 && !target_reaped) {
      long long elapsed = now - cleanup_started_ms;
      int stop_with = elapsed >= CLEANUP_GRACE_MS ? SIGKILL : SIGTERM;
      bool ignored = false;
      if (inspect_children(target_pid, false, true, stop_with, &ignored) != 0) { supervision_failed = true; break; }
      if (now - cleanup_started_ms > CLEANUP_DEADLINE_MS) { supervision_failed = true; break; }
    }
    short_sleep();
  }

  if (!tree_stopped || supervision_failed) {
#ifdef SOULFORGE_GUARDIAN_TEST_HOOKS
    if (test_reaper_churn) fprintf(stderr, "TEST_REAPER_CHURN_COUNT=%u\n", test_reaper_churn_count);
#endif
    const char *reason = termination_reason ? termination_reason : "tree-unproven";
    if (publish_result(nonce, target_code == 0 ? 1 : (target_code < 0 ? 1 : target_code), target_signal,
        child_exit_code, false, descendants_observed, reason, spawn_errno) != 0) return 4;
    return 1;
  }

  if (spawn_errno != 0) termination_reason = "spawn-error";
  int final_code = target_code < 0 ? 1 : target_code;
  if (descendants_observed && final_code == 0 && (!termination_reason || strcmp(termination_reason, "descendant-leak") == 0)) {
    final_code = 1;
    if (!termination_reason) termination_reason = "descendant-leak";
  }
  if (publish_result(nonce, final_code, target_signal, child_exit_code, true, descendants_observed,
      termination_reason, spawn_errno) != 0) return 4;
  return 0;
}

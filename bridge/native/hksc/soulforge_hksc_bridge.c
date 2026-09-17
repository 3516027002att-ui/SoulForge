/*
 * SoulForge HKS compiler bridge.
 *
 * This is the small C ABI surface consumed by the managed Bridge.  The
 * parser, bytecode emitter and all allocation state remain in this process;
 * no executable, editor, runtime locator or environment variable is used.
 */
#include "hksclib.h"
#include "lobject.h"
#include "lstate.h"
#include "lopcodes.h"
#ifdef _WIN32
#include <windows.h>
#endif
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    unsigned char *data;
    size_t size;
    size_t capacity;
} sf_buffer;

typedef enum {
    SF_LUA50_ABC,
    SF_LUA50_ABX,
    SF_LUA50_ASBX
} sf_lua50_mode;

/* The LuaP emitter is deliberately fail-closed.  Keep the first failing
 * layout component in the native diagnostic so a corpus gap can be fixed at
 * the actual boundary instead of being reported as a generic compiler
 * failure. */
static const char *sf_lua50_failure = "unknown";
static char sf_lua50_failure_detail[128];

static int sf_buffer_reserve(sf_buffer *out, size_t additional) {
    unsigned char *next;
    size_t required;
    size_t capacity;
    if (additional > (size_t)-1 - out->size) return 1;
    required = out->size + additional;
    if (required <= out->capacity) return 0;
    capacity = out->capacity == 0 ? 4096 : out->capacity;
    while (capacity < required) {
        if (capacity > ((size_t)-1) / 2) return 1;
        capacity *= 2;
    }
    next = (unsigned char *)realloc(out->data, capacity);
    if (!next) return 1;
    out->data = next;
    out->capacity = capacity;
    return 0;
}

static int sf_buffer_append(sf_buffer *out, const void *data, size_t size) {
    if (size == 0) return 0;
    if (sf_buffer_reserve(out, size) != 0) return 1;
    memcpy(out->data + out->size, data, size);
    out->size += size;
    return 0;
}

static int sf_buffer_byte(sf_buffer *out, unsigned char value) {
    return sf_buffer_append(out, &value, 1);
}

static int sf_buffer_u32le(sf_buffer *out, unsigned int value) {
    unsigned char bytes[4];
    bytes[0] = (unsigned char)(value & 0xffu);
    bytes[1] = (unsigned char)((value >> 8) & 0xffu);
    bytes[2] = (unsigned char)((value >> 16) & 0xffu);
    bytes[3] = (unsigned char)((value >> 24) & 0xffu);
    return sf_buffer_append(out, bytes, sizeof(bytes));
}

static int sf_buffer_i32le(sf_buffer *out, int value) {
    return sf_buffer_u32le(out, (unsigned int)value);
}

static int sf_buffer_u64le(sf_buffer *out, unsigned long long value) {
    unsigned char bytes[8];
    int i;
    for (i = 0; i < 8; ++i) bytes[i] = (unsigned char)((value >> (i * 8)) & 0xffu);
    return sf_buffer_append(out, bytes, sizeof(bytes));
}

static int sf_buffer_doublele(sf_buffer *out, lua_Number value) {
    /* The bundled hksc parser intentionally uses float values, while the
     * Sekiro LuaP container declares an 8-byte IEEE-754 number.  Widen the
     * parsed value at the format boundary; rejecting it here would make even
     * a scalar-only LuaP source impossible to round-trip. */
    double widened = (double)value;
    unsigned char bytes[8];
    memcpy(bytes, &widened, sizeof(bytes));
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    {
        int left;
        for (left = 0; left < 4; ++left) {
            unsigned char temp = bytes[left];
            bytes[left] = bytes[7 - left];
            bytes[7 - left] = temp;
        }
    }
#endif
    return sf_buffer_append(out, bytes, sizeof(bytes));
}

/*
 * LuaP stores strings as Shift-JIS, while the first-party compiler receives
 * UTF-8 source.  Keep the conversion in the native emitter so a Japanese
 * identifier/string does not become mojibake after a round trip.  The
 * non-Windows fallback is only for source builds; Sekiro production binaries
 * are built on Windows and use CP932 explicitly.
 */
static int sf_lua50_string_bytes(const TString *string, unsigned char **bytes, size_t *size) {
    const char *source;
    size_t source_size;
    if (!string || !bytes || !size) { sf_lua50_failure = "string-arguments"; return 1; }
    source = getstr(string);
    source_size = string->tsv.len;
    if (source_size == 0) {
        *bytes = (unsigned char *)malloc(1);
        if (!*bytes) { sf_lua50_failure = "empty-string-allocation"; return 1; }
        *size = 0;
        return 0;
    }
#ifdef _WIN32
    {
        int wide_size;
        int encoded_size;
        wchar_t *wide;
        unsigned char *encoded;
        if (source_size > 0x7fffffffU) { sf_lua50_failure = "string-too-large"; return 1; }
        wide_size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
            source, (int)source_size, NULL, 0);
        if (wide_size <= 0) {
            snprintf(sf_lua50_failure_detail, sizeof(sf_lua50_failure_detail),
                "string-utf8-decode-size-%u-first-%02X-%02X-%02X-%02X",
                (unsigned int)source_size,
                source_size > 0 ? (unsigned char)source[0] : 0,
                source_size > 1 ? (unsigned char)source[1] : 0,
                source_size > 2 ? (unsigned char)source[2] : 0,
                source_size > 3 ? (unsigned char)source[3] : 0);
            sf_lua50_failure = sf_lua50_failure_detail;
            return 1;
        }
        wide = (wchar_t *)malloc((size_t)wide_size * sizeof(wchar_t));
        if (!wide) { sf_lua50_failure = "string-wide-allocation"; return 1; }
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
            source, (int)source_size, wide, wide_size) != wide_size) {
            free(wide);
            sf_lua50_failure = "string-utf8-decode-2"; return 1;
        }
        encoded_size = WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS,
            wide, wide_size, NULL, 0, NULL, NULL);
        if (encoded_size <= 0) {
            free(wide);
            sf_lua50_failure = "string-cp932-size"; return 1;
        }
        encoded = (unsigned char *)malloc((size_t)encoded_size);
        if (!encoded) {
            free(wide);
            sf_lua50_failure = "string-cp932-allocation"; return 1;
        }
        if (WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS,
            wide, wide_size, (char *)encoded, encoded_size, NULL, NULL) != encoded_size) {
            free(encoded);
            free(wide);
            sf_lua50_failure = "string-cp932-encode"; return 1;
        }
        free(wide);
        *bytes = encoded;
        *size = (size_t)encoded_size;
        return 0;
    }
#else
    *bytes = (unsigned char *)malloc(source_size == 0 ? 1 : source_size);
    if (!*bytes) return 1;
    if (source_size > 0) memcpy(*bytes, source, source_size);
    *size = source_size;
    return 0;
#endif
}

static int sf_dump_string50(sf_buffer *out, const TString *string) {
    unsigned char *bytes = NULL;
    size_t size = 0;
    int result;
    if (!string) return sf_buffer_u64le(out, 0);
    if (sf_lua50_string_bytes(string, &bytes, &size) != 0) return 1;
    if (size > ((size_t)-1) - 1) {
        free(bytes);
        return 1;
    }
    result = sf_buffer_u64le(out, (unsigned long long)(size + 1));
    if (result == 0) result = sf_buffer_append(out, bytes, size);
    if (result == 0) result = sf_buffer_byte(out, 0);
    free(bytes);
    return result;
}

static int sf_lua50_rk(unsigned int raw, int *value) {
    unsigned int index;
    if (!value) { sf_lua50_failure = "rk-null"; return 1; }
    if ((raw & 0x100u) == 0) {
        *value = (int)(raw & 0xffu);
        return 0;
    }
    index = raw & 0xffu;
    if (index > 261u) { sf_lua50_failure = "rk-constant-index"; return 1; }
    *value = 250 + (int)index;
    return 0;
}

static int sf_lua50_direct_constant(unsigned int index, int *value) {
    if (!value || index > 261u) { sf_lua50_failure = "direct-constant-index"; return 1; }
    *value = 250 + (int)index;
    return 0;
}

static int sf_hks_opcode_to_lua50(OpCode opcode, sf_lua50_mode *mode) {
    if (!mode) { sf_lua50_failure = "opcode-mode-null"; return -1; }
    switch (opcode) {
        case OP_GETFIELD: case OP_GETFIELD_R1: case OP_GETFIELD_MM:
        case OP_GETTABLE_S: case OP_GETTABLE_N: case OP_GETTABLE:
            *mode = SF_LUA50_ABC; return 6; /* GETTABLE */
        case OP_TEST: case OP_TEST_R1:
            *mode = SF_LUA50_ABC; return 24; /* TEST */
        case OP_CALL_I: case OP_CALL_C: case OP_CALL_M: case OP_CALL:
        case OP_CALL_I_R1:
            *mode = SF_LUA50_ABC; return 25; /* CALL */
        case OP_EQ: case OP_EQ_BK:
            *mode = SF_LUA50_ABC; return 21; /* EQ */
        case OP_GETGLOBAL: case OP_GETGLOBAL_MEM:
            *mode = SF_LUA50_ABX; return 5; /* GETGLOBAL */
        case OP_MOVE:
            *mode = SF_LUA50_ABC; return 0;
        case OP_SELF:
            *mode = SF_LUA50_ABC; return 11;
        case OP_RETURN:
            *mode = SF_LUA50_ABC; return 27;
        case OP_LOADBOOL:
            *mode = SF_LUA50_ABC; return 2;
        case OP_TFORLOOP:
            *mode = SF_LUA50_ABC; return 29;
        case OP_SETFIELD: case OP_SETFIELD_R1:
        case OP_SETTABLE_S: case OP_SETTABLE_S_BK:
        case OP_SETTABLE_N: case OP_SETTABLE_N_BK:
        case OP_SETTABLE: case OP_SETTABLE_BK:
            *mode = SF_LUA50_ABC; return 9; /* SETTABLE */
        case OP_TAILCALL_I: case OP_TAILCALL_C: case OP_TAILCALL_M:
        case OP_TAILCALL: case OP_TAILCALL_I_R1:
            *mode = SF_LUA50_ABC; return 26; /* TAILCALL */
        case OP_LOADK:
            *mode = SF_LUA50_ABX; return 1;
        case OP_LOADNIL:
            *mode = SF_LUA50_ABC; return 3;
        case OP_SETGLOBAL:
            *mode = SF_LUA50_ABX; return 7;
        case OP_JMP:
            *mode = SF_LUA50_ASBX; return 20;
        case OP_GETUPVAL:
            *mode = SF_LUA50_ABC; return 4;
        case OP_SETUPVAL: case OP_SETUPVAL_R1:
            *mode = SF_LUA50_ABC; return 8;
        case OP_ADD: case OP_ADD_BK:
            *mode = SF_LUA50_ABC; return 12;
        case OP_SUB: case OP_SUB_BK:
            *mode = SF_LUA50_ABC; return 13;
        case OP_MUL: case OP_MUL_BK:
            *mode = SF_LUA50_ABC; return 14;
        case OP_DIV: case OP_DIV_BK:
            *mode = SF_LUA50_ABC; return 15;
        case OP_POW: case OP_POW_BK:
            *mode = SF_LUA50_ABC; return 16;
        case OP_UNM:
            *mode = SF_LUA50_ABC; return 17;
        case OP_NOT: case OP_NOT_R1:
            *mode = SF_LUA50_ABC; return 18;
        case OP_NEWTABLE:
            *mode = SF_LUA50_ABC; return 10;
        case OP_CONCAT:
            *mode = SF_LUA50_ABC; return 19;
        case OP_LT: case OP_LT_BK:
            *mode = SF_LUA50_ABC; return 22;
        case OP_LE: case OP_LE_BK:
            *mode = SF_LUA50_ABC; return 23;
        case OP_SETLIST:
            *mode = SF_LUA50_ABC; return 31;
        case OP_FORPREP:
            *mode = SF_LUA50_ASBX; return 30; /* TFORPREP */
        case OP_FORLOOP:
            *mode = SF_LUA50_ASBX; return 28;
        case OP_CLOSURE:
            *mode = SF_LUA50_ABX; return 34;
        case OP_CLOSE:
            *mode = SF_LUA50_ABC; return 33;
        default:
            return -1;
    }
}

static int sf_lua50_constant(sf_buffer *out, const TValue *value) {
    if (ttisnil(value)) return sf_buffer_byte(out, 0);
    if (ttisboolean(value)) {
        if (sf_buffer_byte(out, 1) != 0) return 1;
        return sf_buffer_byte(out, bvalue(value) ? 1 : 0);
    }
    if (ttisnumber(value)) {
        if (sf_buffer_byte(out, 3) != 0) return 1;
        return sf_buffer_doublele(out, nvalue(value));
    }
    if (ttisstring(value)) {
        if (sf_buffer_byte(out, 4) != 0) return 1;
        return sf_dump_string50(out, rawtsvalue(value));
    }
    snprintf(sf_lua50_failure_detail, sizeof(sf_lua50_failure_detail),
        "constant-type-%d", ttype(value));
    sf_lua50_failure = sf_lua50_failure_detail;
    return 1;
}

static int sf_lua50_instruction(
    const Proto *function,
    Instruction instruction,
    unsigned int pc,
    const unsigned int *pc_map,
    unsigned int output_pc,
    unsigned int *encoded,
    int *skip_data) {
    OpCode hks_opcode = GET_OPCODE(instruction);
    sf_lua50_mode mode;
    int opcode = sf_hks_opcode_to_lua50(hks_opcode, &mode);
    unsigned int a = GETARG_A(instruction);
    /* B is eight bits for ordinary HKS instructions; the ninth bit is
     * encoded in the opcode for *_BK variants.  Masking nine bits
     * unconditionally would steal the low opcode bit and turn e.g. RETURN
     * B=2 into B=258 in the LuaP output. */
    unsigned int raw_b = (unsigned int)GETARG_B(instruction);
    unsigned int raw_c = (unsigned int)GETARG_C(instruction);
    unsigned int bx = GETARG_Bx(instruction);
    int b = (int)raw_b;
    int c = (int)raw_c;
    int sbx = GETARG_sBx(instruction);
    if (skip_data) *skip_data = 0;
    if (opcode < 0 || a > 255u) {
        snprintf(sf_lua50_failure_detail, sizeof(sf_lua50_failure_detail),
            "instruction-opcode-%d-a-%u", (int)hks_opcode, a);
        sf_lua50_failure = sf_lua50_failure_detail;
        return 1;
    }
    if (hks_opcode == OP_DATA) { sf_lua50_failure = "instruction-data"; return 1; }
    if (hks_opcode == OP_GETFIELD || hks_opcode == OP_GETFIELD_R1 || hks_opcode == OP_GETFIELD_MM) {
        if (sf_lua50_direct_constant(raw_c, &c) != 0) return 1;
    } else if (hks_opcode == OP_SETFIELD || hks_opcode == OP_SETFIELD_R1) {
        if (sf_lua50_direct_constant(raw_b, &b) != 0) return 1;
        if (sf_lua50_rk(raw_c, &c) != 0) return 1;
    } else {
        if (getBMode(hks_opcode) == OpArgRK && sf_lua50_rk(raw_b, &b) != 0) return 1;
        if (getCMode(hks_opcode) == OpArgRK && sf_lua50_rk(raw_c, &c) != 0) return 1;
    }
    if (hks_opcode == OP_TEST || hks_opcode == OP_TEST_R1) {
        /* HKS TEST uses A as the tested register; Lua 5.0 calls it B. */
        b = (int)a;
        if (c > 1) { sf_lua50_failure = "test-condition"; return 1; }
    }
    if (hks_opcode == OP_EQ_BK) {
        if (sf_lua50_direct_constant(raw_b & 0xffu, &b) != 0) { sf_lua50_failure = "eq-constant"; return 1; }
    }
    if (hks_opcode == OP_FORPREP || hks_opcode == OP_FORLOOP || hks_opcode == OP_JMP) {
        int target;
        if (sbx < -131071 || sbx > 131071) { sf_lua50_failure = "jump-range"; return 1; }
        target = (int)pc + 1 + sbx;
        if (target < 0 || target > (int)function->sizecode) {
            sf_lua50_failure = "jump-target-range";
            return 1;
        }
        /* Both HKS and LuaP target pc + 1 + sBx.  Translate through the
         * filtered instruction map so omitted HKS DATA records do not corrupt
         * loops or conditional branches. */
        if (pc_map) sbx = (int)pc_map[target] - (int)output_pc - 1;
    }
    if (hks_opcode == OP_CLOSURE && bx >= (unsigned int)function->sizep) { sf_lua50_failure = "closure-index"; return 1; }
    if (b < 0 || b > 511 || c < 0 || c > 511) { sf_lua50_failure = "instruction-operand-range"; return 1; }
    if (mode == SF_LUA50_ABX) {
        if (bx > 262143u) { sf_lua50_failure = "abx-range"; return 1; }
        *encoded = ((unsigned int)opcode & 0x3fu)
            | (a << 24) | (bx << 6);
    } else if (mode == SF_LUA50_ASBX) {
        unsigned int encoded_sbx = (unsigned int)(sbx + 131071);
        if (encoded_sbx > 262143u) { sf_lua50_failure = "asbx-range"; return 1; }
        *encoded = ((unsigned int)opcode & 0x3fu)
            | (a << 24) | (encoded_sbx << 6);
    } else {
        *encoded = ((unsigned int)opcode & 0x3fu)
            | (a << 24) | ((unsigned int)b << 15) | ((unsigned int)c << 6);
    }
    if (hks_opcode == OP_CLOSURE && skip_data) {
        const Proto *child = function->p[bx];
        unsigned int j;
        for (j = 0; j < (unsigned int)child->sizeupvalues; ++j) {
            unsigned int data_pc = pc + j + 1;
            if (data_pc >= (unsigned int)function->sizecode
                || GET_OPCODE(function->code[data_pc]) != OP_DATA) { sf_lua50_failure = "closure-data-missing"; return 1; }
            /* HKS DATA.A selects a parent local (1) or parent upvalue (2),
             * while DATA.Bx carries its index.  Lua 5.0 represents the same
             * binding with a MOVE or GETUPVAL instruction after CLOSURE. */
            if (GETARG_A(function->code[data_pc]) != 1
                && GETARG_A(function->code[data_pc]) != 2) {
                sf_lua50_failure = "closure-data-kind";
                return 1;
            }
        }
        *skip_data = (int)child->sizeupvalues;
    }
    return 0;
}

static int sf_lua50_closure_binding(Instruction data, unsigned int *encoded) {
    unsigned int source_kind = (unsigned int)GETARG_A(data);
    unsigned int source_index = (unsigned int)GETARG_Bx(data);
    unsigned int opcode;
    if (!encoded || GET_OPCODE(data) != OP_DATA || source_index > 255u) {
        sf_lua50_failure = "closure-data-range";
        return 1;
    }
    if (source_kind == 1) opcode = 0;       /* MOVE */
    else if (source_kind == 2) opcode = 4;  /* GETUPVAL */
    else {
        sf_lua50_failure = "closure-data-kind";
        return 1;
    }
    *encoded = opcode | (source_index << 15);
    return 0;
}

static int sf_lua50_build_pc_map(const Proto *function, unsigned int **out_map) {
    unsigned int *map;
    unsigned int old_pc = 0;
    unsigned int output_pc = 0;
    if (!function || !out_map || function->sizecode < 0) {
        sf_lua50_failure = "pc-map-arguments";
        return 1;
    }
    map = (unsigned int *)calloc((size_t)function->sizecode + 1, sizeof(unsigned int));
    if (!map) {
        sf_lua50_failure = "pc-map-allocation";
        return 1;
    }
    while (old_pc < (unsigned int)function->sizecode) {
        Instruction instruction = function->code[old_pc];
        OpCode opcode = GET_OPCODE(instruction);
        int data_count = 0;
        unsigned int ignored = 0;
        map[old_pc] = output_pc;
        if (opcode == OP_DATA) {
            old_pc++;
            continue;
        }
        if (sf_lua50_instruction(function, instruction, old_pc, NULL, output_pc, &ignored, &data_count) != 0) {
            free(map);
            return 1;
        }
        if (output_pc == (unsigned int)-1) {
            sf_lua50_failure = "pc-map-range";
            free(map);
            return 1;
        }
        output_pc++;
        if (opcode == OP_CLOSURE) {
            unsigned int j;
            for (j = 0; j < (unsigned int)data_count; ++j)
                map[old_pc + j + 1] = output_pc + j;
            output_pc += (unsigned int)data_count;
            old_pc += (unsigned int)data_count + 1;
        } else {
            old_pc++;
        }
    }
    map[function->sizecode] = output_pc;
    *out_map = map;
    return 0;
}

static int sf_lua50_dump_function(sf_buffer *out, const Proto *function) {
    unsigned int i;
    unsigned int *pc_map = NULL;
    unsigned int output_instruction_count;
    if (sf_lua50_build_pc_map(function, &pc_map) != 0) return 1;
    output_instruction_count = pc_map[function->sizecode];
    if (sf_dump_string50(out, function->name) != 0
        || sf_buffer_i32le(out, function->linedefined) != 0
        || sf_buffer_byte(out, function->nups) != 0
        || sf_buffer_byte(out, function->numparams) != 0
        || sf_buffer_byte(out, function->is_vararg) != 0
        || sf_buffer_byte(out, function->maxstacksize) != 0
        || sf_buffer_i32le(out, (int)output_instruction_count) != 0) { sf_lua50_failure = "function-header"; free(pc_map); return 1; }
    for (i = 0; i < (unsigned int)function->sizecode; ) {
        unsigned int encoded = 0;
        int data_count = 0;
        unsigned int line = function->lineinfo && i < (unsigned int)function->sizelineinfo
            ? (unsigned int)function->lineinfo[i] : 0;
        if (GET_OPCODE(function->code[i]) == OP_DATA) {
            i++;
            continue;
        }
        if (sf_lua50_instruction(function, function->code[i], i, pc_map, pc_map[i], &encoded, &data_count) != 0) {
            free(pc_map);
            return 1;
        }
        if (sf_buffer_i32le(out, (int)line) != 0) { sf_lua50_failure = "line-info"; free(pc_map); return 1; }
        for (unsigned int j = 0; j < (unsigned int)data_count; ++j) {
            unsigned int binding_line = function->lineinfo && i + j + 1 < (unsigned int)function->sizelineinfo
                ? (unsigned int)function->lineinfo[i + j + 1] : line;
            if (sf_buffer_i32le(out, (int)binding_line) != 0) { sf_lua50_failure = "closure-line-info"; free(pc_map); return 1; }
        }
        i += (unsigned int)data_count + 1;
    }
    if (sf_buffer_i32le(out, function->sizelocvars) != 0) { sf_lua50_failure = "local-count"; free(pc_map); return 1; }
    for (i = 0; i < (unsigned int)function->sizelocvars; ++i) {
        int start = function->locvars[i].startpc;
        int end = function->locvars[i].endpc;
        if (start < 0 || end < start || end > function->sizecode) {
            sf_lua50_failure = "local-range";
            free(pc_map);
            return 1;
        }
        if (sf_dump_string50(out, function->locvars[i].varname) != 0
            || sf_buffer_i32le(out, (int)pc_map[start]) != 0
            || sf_buffer_i32le(out, (int)pc_map[end]) != 0) { sf_lua50_failure = "local-info"; free(pc_map); return 1; }
    }
    if (sf_buffer_i32le(out, function->sizeupvalues) != 0) { sf_lua50_failure = "upvalue-count"; free(pc_map); return 1; }
    for (i = 0; i < (unsigned int)function->sizeupvalues; ++i) {
        if (sf_dump_string50(out, function->upvalues[i]) != 0) { sf_lua50_failure = "upvalue-info"; free(pc_map); return 1; }
    }
    if (sf_buffer_i32le(out, function->sizek) != 0) { sf_lua50_failure = "constant-count"; free(pc_map); return 1; }
    for (i = 0; i < (unsigned int)function->sizek; ++i) {
        if (sf_lua50_constant(out, &function->k[i]) != 0) { free(pc_map); return 1; }
    }
    if (sf_buffer_i32le(out, function->sizep) != 0) { sf_lua50_failure = "child-count"; free(pc_map); return 1; }
    for (i = 0; i < (unsigned int)function->sizep; ++i) {
        if (sf_lua50_dump_function(out, function->p[i]) != 0) { free(pc_map); return 1; }
    }
    /* Count/emit filtered instructions after validating closure DATA pairs. */
    {
        unsigned int count = output_instruction_count;
        for (i = 0; i < (unsigned int)function->sizecode; ++i) {
            unsigned int encoded;
            int data_count = 0;
            /* HKS adds DATA metadata around table/memo operations.  LuaP has
             * no DATA opcode, so those auxiliary records are intentionally
             * omitted; closure DATA records are consumed and re-encoded by
             * the CLOSURE case below. */
            if (GET_OPCODE(function->code[i]) == OP_DATA) continue;
            if (sf_lua50_instruction(function, function->code[i], i, pc_map, pc_map[i], &encoded, &data_count) != 0) {
                free(pc_map);
                return 1;
            }
            i += (unsigned int)data_count;
        }
        if (sf_buffer_i32le(out, (int)count) != 0) { sf_lua50_failure = "instruction-count"; free(pc_map); return 1; }
        for (i = 0; i < (unsigned int)function->sizecode; ++i) {
            unsigned int encoded;
            int data_count = 0;
            if (GET_OPCODE(function->code[i]) == OP_DATA) continue;
            if (sf_lua50_instruction(function, function->code[i], i, pc_map, pc_map[i], &encoded, &data_count) != 0) {
                free(pc_map);
                return 1;
            }
            if (sf_buffer_u32le(out, encoded) != 0) { sf_lua50_failure = "instruction-write"; free(pc_map); return 1; }
            if (GET_OPCODE(function->code[i]) == OP_CLOSURE) {
                unsigned int j;
                for (j = 0; j < (unsigned int)data_count; ++j) {
                    unsigned int binding;
                    if (sf_lua50_closure_binding(function->code[i + j + 1], &binding) != 0) { free(pc_map); return 1; }
                    if (sf_buffer_u32le(out, binding) != 0) { sf_lua50_failure = "closure-binding-write"; free(pc_map); return 1; }
                }
            }
            i += (unsigned int)data_count;
        }
        free(pc_map);
    }
    return 0;
}

static int sf_dump_lua50_header(sf_buffer *out) {
    static const unsigned char magic[] = { 0x1b, 'L', 'u', 'a' };
    if (sf_buffer_append(out, magic, sizeof(magic)) != 0
        || sf_buffer_byte(out, 0x50) != 0
        || sf_buffer_byte(out, 0x01) != 0
        || sf_buffer_byte(out, 0x04) != 0
        || sf_buffer_byte(out, 0x08) != 0
        || sf_buffer_byte(out, 0x04) != 0
        || sf_buffer_byte(out, 0x06) != 0
        || sf_buffer_byte(out, 0x08) != 0
        || sf_buffer_byte(out, 0x09) != 0
        || sf_buffer_byte(out, 0x09) != 0
        || sf_buffer_byte(out, 0x08) != 0) return 1;
    return sf_buffer_doublele(out, (lua_Number)3.14159265358979323846);
}

static int sf_dump_lua50(hksc_State *H, void *ud) {
    sf_buffer *out = (sf_buffer *)ud;
    int failed = 0;
    sf_lua50_failure = "unknown";
    sf_lua50_failure_detail[0] = '\0';
    if (!H) {
        sf_lua50_failure = "state-null";
        failed = 1;
    } else if (!H->last_result) {
        sf_lua50_failure = "proto-null";
        failed = 1;
    } else if (sf_dump_lua50_header(out) != 0) {
        sf_lua50_failure = "header";
        failed = 1;
    } else if (sf_lua50_dump_function(out, H->last_result) != 0) {
        failed = 1;
    }
    if (failed) {
        char message[256];
        snprintf(message, sizeof(message), "LUA50_COMPILER_UNSUPPORTED_LAYOUT: HKS Proto cannot be encoded as Sekiro LuaP (%s).", sf_lua50_failure);
        lua_seterror(H, message);
        return 1;
    }
    return 0;
}

static int sf_writer(hksc_State *H, const void *p, size_t size, void *ud) {
    sf_buffer *out = (sf_buffer *)ud;
    unsigned char *next;
    size_t required;
    (void)H;
    if (size == 0) return 0;
    required = out->size + size;
    if (required < out->size) return 1;
    if (required > out->capacity) {
        size_t capacity = out->capacity == 0 ? 4096 : out->capacity;
        while (capacity < required) {
            if (capacity > ((size_t)-1) / 2) return 1;
            capacity *= 2;
        }
        next = (unsigned char *)realloc(out->data, capacity);
        if (!next) return 1;
        out->data = next;
        out->capacity = capacity;
    }
    memcpy(out->data + out->size, p, size);
    out->size = required;
    return 0;
}

static int sf_dump(hksc_State *H, void *ud) {
    return lua_dump(H, sf_writer, ud);
}

static int sf_copy_error(hksc_State *H, char *error, size_t error_size, int status) {
    const char *message = lua_geterror(H);
    const char *fallback = status == LUA_ERRMEM
        ? "SoulForge HKS compiler out of memory"
        : "SoulForge HKS compiler failed";
    if (!error || error_size == 0) return status;
    if (!message || !*message) message = fallback;
    strncpy(error, message, error_size - 1);
    error[error_size - 1] = '\0';
    return status;
}

static int sf_compile(
    const char *source,
    size_t source_size,
    unsigned char **output,
    size_t *output_size,
    char *error,
    size_t error_size,
    int lua50) {
    hksc_StateSettings settings;
    hksc_State *H;
    sf_buffer out;
    int status;

    if (!source || !output || !output_size) return -1;
    *output = NULL;
    *output_size = 0;
    out.data = NULL;
    out.size = 0;
    out.capacity = 0;

    hksI_settings(&settings);
    settings.mode = HKSC_MODE_SOURCE;
    /* Sekiro stores the HKS chunk in big-endian form (header byte 0x06 = 0). */
    settings.bytecode_endianness = HKSC_BIG_ENDIAN;
    settings.compilersettings.strip = BYTECODE_STRIPPING_NONE;
    settings.compilersettings.ignore_debug = 0;
    settings.compilersettings.literals = INT_LITERALS_ALL;
    if (lua50) {
        /* LuaP has neither HKS structure metadata nor global memo DATA
         * records.  The source language remains ordinary Lua 5.0; HKS-only
         * extensions therefore fail in the parser or are not emitted into
         * the target instruction stream. */
        settings.compilersettings.emit_struct = 0;
        settings.compilersettings.emit_memo = 0;
        /* skip_memo is a testing switch in hksc: it inserts an early RETURN
         * into every function.  It is not the inverse of emit_memo and must
         * remain off for a real LuaP compile. */
        settings.compilersettings.skip_memo = 0;
    }

    H = hksI_newstate(&settings);
    if (!H) {
        if (error && error_size > 0) {
            strncpy(error, "SoulForge HKS compiler state allocation failed", error_size - 1);
            error[error_size - 1] = '\0';
        }
        return LUA_ERRMEM;
    }

    status = hksI_parser_buffer(H, source, source_size, "=SoulForge",
        lua50 ? sf_dump_lua50 : sf_dump, &out);
    if (status != 0) {
        sf_copy_error(H, error, error_size, status);
        free(out.data);
        hksI_close(H);
        return status;
    }

    hksI_close(H);
    *output = out.data;
    *output_size = out.size;
    if (error && error_size > 0) error[0] = '\0';
    return 0;
}

__declspec(dllexport) int SoulForgeHksCompile(
    const char *source,
    size_t source_size,
    unsigned char **output,
    size_t *output_size,
    char *error,
    size_t error_size) {
    return sf_compile(source, source_size, output, output_size, error, error_size, 0);
}

__declspec(dllexport) int SoulForgeLua50Compile(
    const char *source,
    size_t source_size,
    unsigned char **output,
    size_t *output_size,
    char *error,
    size_t error_size) {
    return sf_compile(source, source_size, output, output_size, error, error_size, 1);
}

__declspec(dllexport) void SoulForgeHksFree(void *pointer) {
    free(pointer);
}

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type DoctorStatus = 'Pass' | 'Warn' | 'Fail';

export interface DoctorItem {
  key: string;
  title: string;
  status: DoctorStatus;
  message: string;
  details?: unknown;
  fixable: boolean;
  fixDescription?: string | null;
}

export interface DoctorReport {
  timestamp: string;
  overallStatus: DoctorStatus;
  detectedSekiroPath?: string | null;
  detectedModsPath?: string | null;
  items: DoctorItem[];
}

export interface AutoFixActionRecord {
  name: string;
  success: boolean;
  message: string;
}

export interface AutoFixResult {
  success: boolean;
  message: string;
  actions: AutoFixActionRecord[];
  sekiroPath?: string | null;
  modsPath?: string | null;
}

export interface DoctorOptions {
  sekiroPath?: string;
  modsPath?: string;
  doctorExecutablePath?: string;
}

function resolveDoctorExecutable(customPath?: string): { executable: string; args: string[] } | null {
  if (customPath && existsSync(customPath)) {
    return { executable: resolve(customPath), args: [] };
  }

  // 1. 尝试当前工作目录或上层打包工具路径
  const candidates = [
    join(process.cwd(), 'release', 'tools', 'SoulForge.Doctor.exe'),
    join(process.cwd(), 'bridge', 'SoulForge.Doctor', 'bin', 'Release', 'net6.0', 'win-x64', 'publish', 'SoulForge.Doctor.exe'),
    join(process.cwd(), 'bridge', 'SoulForge.Doctor', 'bin', 'Debug', 'net6.0', 'win-x64', 'SoulForge.Doctor.exe')
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      return { executable: c, args: [] };
    }
  }

  return null;
}

export async function runDoctorDiagnosis(options: DoctorOptions = {}): Promise<DoctorReport> {
  const doctor = resolveDoctorExecutable(options.doctorExecutablePath);
  if (doctor) {
    const args = [...doctor.args, '--json'];
    if (options.sekiroPath) args.push('--game-dir', options.sekiroPath);
    if (options.modsPath) args.push('--mods-dir', options.modsPath);

    const proc = spawnSync(doctor.executable, args, {
      encoding: 'utf8',
      windowsHide: true
    });

    if (proc.stdout) {
      try {
        const parsed = JSON.parse(proc.stdout.trim()) as DoctorReport;
        return parsed;
      } catch {
        // Fallthrough
      }
    }
  }

  // 纯 Node 兜底快速诊断
  return fallbackNodeDiagnosis(options);
}

export async function runDoctorAutoFix(options: DoctorOptions = {}): Promise<AutoFixResult> {
  const doctor = resolveDoctorExecutable(options.doctorExecutablePath);
  if (doctor) {
    const args = [...doctor.args, '--fix', '--json'];
    if (options.sekiroPath) args.push('--game-dir', options.sekiroPath);
    if (options.modsPath) args.push('--mods-dir', options.modsPath);

    const proc = spawnSync(doctor.executable, args, {
      encoding: 'utf8',
      windowsHide: true
    });

    if (proc.stdout) {
      try {
        const parsed = JSON.parse(proc.stdout.trim()) as AutoFixResult;
        return parsed;
      } catch {
        // Fallthrough
      }
    }
  }

  return {
    success: false,
    message: '未能启动 SoulForge.Doctor 修复程序',
    actions: []
  };
}

function fallbackNodeDiagnosis(options: DoctorOptions): DoctorReport {
  const items: DoctorItem[] = [];
  const defaultSekiro = options.sekiroPath || 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
  const sekiroExists = existsSync(join(defaultSekiro, 'sekiro.exe'));

  items.push({
    key: 'sekiro_game_path',
    title: '《只狼》游戏安装路径',
    status: sekiroExists ? 'Pass' : 'Warn',
    message: sekiroExists ? `已定位只狼游戏安装目录: ${defaultSekiro}` : '未找到只狼游戏目录，请指定路径',
    fixable: false
  });

  const oodleExists = sekiroExists && existsSync(join(defaultSekiro, 'oo2core_6_win64.dll'));
  items.push({
    key: 'oodle_library',
    title: 'Oodle 动态解密库 (oo2core_6_win64.dll)',
    status: oodleExists ? 'Pass' : 'Warn',
    message: oodleExists ? '已在只狼目录中找到合法的 oo2core_6_win64.dll' : '未找到 oo2core_6_win64.dll',
    fixable: true,
    fixDescription: '自动从只狼游戏目录安全复制 oo2core_6_win64.dll'
  });

  return {
    timestamp: new Date().toISOString(),
    overallStatus: sekiroExists ? 'Pass' : 'Warn',
    detectedSekiroPath: sekiroExists ? defaultSekiro : null,
    detectedModsPath: sekiroExists ? join(defaultSekiro, 'mods') : null,
    items
  };
}

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultDwgConverter = fileURLToPath(new URL('./tools/libredwg/dwg2dxf.exe', import.meta.url));
export async function convertDwg(buffer, { converterPath = defaultDwgConverter } = {}) {
  if (process.platform !== 'win32') throw new Error('内置DWG转换器仅支持Windows');
  if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer.length > 10 * 1024 * 1024) throw new Error('DWG文件无效或超过10 MB');
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (!/^AC10\d{2}$/.test(signature)) throw new Error('文件不是受支持的DWG，不能只修改文件扩展名');
  const directory = await mkdtemp(join(tmpdir(), 'board-cut-dwg-'));
  try {
    const input = join(directory, 'input.dwg'), output = join(directory, 'output.dxf');
    await writeFile(input, buffer);
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execFile(converterPath, ['-o', output, input], { cwd: directory, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) reject(new Error(error.code === 'ENOENT' ? 'DWG转换组件缺失，请完整解压便携包' : error.killed ? 'DWG转换超时，请简化图纸后重试' : 'DWG转换失败，文件可能损坏或含不支持的对象'));
        else resolve({ stdout, stderr });
      });
    });
    const log = stdout + '\n' + stderr;
    if (/\bERROR\s*:/i.test(log)) throw new Error('DWG解码存在错误，已取消导入；请在CAD中修复图纸后重试');
    if ((await stat(output)).size > 10 * 1024 * 1024) throw new Error('转换后的DXF超过10 MB，请拆分图纸');
    const dxf = await readFile(output, 'utf8');
    if (!dxf.includes('EOF')) throw new Error('DWG转换结果不完整');
    const warnings = [...new Set(log.split(/\r?\n/).filter(line => /^Warning:/i.test(line)).map(line => line.slice(0, 300)))].slice(0, 30);
    // Unhandled manufacturing entities must never disappear during conversion.
    if (warnings.some(line => /Unhandled (?:Entity|Class entity)|Unknown entity|Unsupported entity/i.test(line))) throw new Error('DWG含未支持的实体，已取消导入以避免丢失加工轮廓');
    return { dxf, warnings, converter: 'LibreDWG 0.14', signature };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

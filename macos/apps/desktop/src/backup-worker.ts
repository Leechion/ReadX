import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createBackup, restoreBackup, type BackupRoots } from './backup';

interface Plan {
  action: 'create' | 'restore'; archive: string; roots: BackupRoots; browserState: string;
  parents: number[]; executable: string; args: string[]; result: string;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function main(): Promise<void> {
  const planPath = process.argv[2];
  if (!planPath) throw new Error('缺少备份操作参数');
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as Plan;
  let message: string;
  try {
    const deadline = Date.now() + 60_000;
    while (plan.parents.some(alive)) {
      if (Date.now() > deadline) throw new Error('应用或本地服务尚未退出，未修改书库，请关闭后重试');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (plan.action === 'create') await createBackup(plan.archive, plan.roots, plan.browserState);
    else await restoreBackup(plan.archive, plan.roots, plan.browserState);
    message = plan.action === 'create' ? `备份已完成并通过校验：\n${plan.archive}` : '备份文件已恢复，打开界面时将继续恢复桌面存储。恢复前的数据保留在原目录旁的 .before-restore-* 文件夹中。跨机器恢复后请重新填写无法解密的密码。';
  } catch (error) {
    message = `操作失败：${error instanceof Error ? error.message : String(error)}`;
  }
  await fs.writeFile(plan.result, JSON.stringify({ message }), { mode: 0o600 });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(plan.executable, [...plan.args, `--readx-backup-result=${plan.result}`], { env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  await fs.rm(path.dirname(planPath), { recursive: true, force: true });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

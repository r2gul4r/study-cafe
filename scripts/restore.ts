import { restoreBackup } from "../src/backup.js";
const [backupDir, targetDir] = process.argv.slice(2);
if (!backupDir || !targetDir)
  throw new Error(
    "Usage: pnpm restore <backup-directory> <data-directory> (server must be stopped)",
  );
console.log(restoreBackup(backupDir, targetDir));

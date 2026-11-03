// A log file that rotates itself: when it passes maxBytes it becomes supervisor.log.1 (older ones shift to .2, .3)
// and a fresh file starts, so the log never grows forever. Used by supervisor.js with --log-file.
import fs from 'node:fs';

export function createRotatingLog(file, { maxBytes = 5 * 1024 * 1024, keep = 3 } = {}) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* new file */ }

  function rotate() {
    try {
      if (fs.existsSync(`${file}.${keep}`)) fs.rmSync(`${file}.${keep}`);
      for (let i = keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
    } catch { /* another program has it open; keep appending and try again next time */ }
    size = 0;
  }

  return {
    file,
    write(text) {
      const chunk = String(text);
      if (size + Buffer.byteLength(chunk) > maxBytes) rotate();
      try {
        fs.appendFileSync(file, chunk);
        size += Buffer.byteLength(chunk);
      } catch { /* the folder became read-only; nothing else to do */ }
    },
  };
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function format(level: string, msg: string): string {
  return `${timestamp()} [${level}] ${msg}`;
}

export const logger = {
  info(msg: string) { console.log(format('INFO', msg)); },
  warn(msg: string) { console.warn(format('WARN', msg)); },
  error(msg: string, err?: unknown) {
    if (err) console.error(format('ERROR', msg), err);
    else console.error(format('ERROR', msg));
  },
};

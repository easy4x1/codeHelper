export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  constructor(private prefix: string = '') {}

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const prefix = this.prefix ? `[${this.prefix}]` : '';
    const output = `${timestamp} ${level.toUpperCase().padStart(5)} ${prefix} ${message}`;
    if (level === 'error') {
      console.error(output, ...args);
    } else {
      console.log(output, ...args);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }
}

export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}

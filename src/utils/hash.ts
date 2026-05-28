import { createHash as cryptoCreateHash } from 'crypto';

export function createHash(content: string): string {
  return cryptoCreateHash('sha256').update(content, 'utf-8').digest('hex');
}

import { helper } from './utils.js';

export function main(): void {
  const result = helper();
  console.log(result);
}

export class App {
  run(): void {
    main();
  }
}

import { greet, greetYell, greetBlock } from './blocks/greet.js';

export const blocks = {
  greet,
  greetYell,
  greetBlock,
};

export function setup() {
  console.log('[greeter] loaded');
}

import { hello } from './blocks/hello.js';

export const blocks = {
  hello,
};

export function setup() {
  console.log('[hello] loaded');
}

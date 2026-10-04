export function greet(args) {
  return 'hello ' + (args.name || 'world');
}

export function greetYell(args) {
  return 'hello ' + (args.name || 'world').toUpperCase();
}

export function greetBlock(args) {
  console.log('greeting', args.name || 'world');
}

(function (Scratch) {
  "use strict";

  console.log('[greeter] loaded');

  class Greeter {
    getInfo() {
      return {
        id: "greeter",
        name: "Greeter",
        color1: "#0094FF",
        color2: "#6100A0",
        color3: "#FFB600",
        blocks: [
          {
            opcode: "greet",
            blockType: Scratch.BlockType.REPORTER,
            text: "hello [name]",
            arguments: {
              name: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "world",
              },
            },
          },
          {
            opcode: "greetYell",
            blockType: Scratch.BlockType.REPORTER,
            text: "hello [name] uppercase",
            arguments: {
              name: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "world",
              },
            },
          },
          {
            opcode: "greetBlock",
            blockType: Scratch.BlockType.COMMAND,
            text: "show greeting [name]",
            arguments: {
              name: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "world",
              },
            },
          },
        ],
      };
    }

    greet(args) {
      return 'hello ' + (args.name || 'world');
    }

    greetYell(args) {
      return 'hello ' + (args.name || 'world').toUpperCase();
    }

    greetBlock(args) {
      console.log('greeting', args.name || 'world');
    }
  }

  Scratch.extensions.register(new Greeter());
})(Scratch);

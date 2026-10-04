(function (Scratch) {
  "use strict";

  console.log('[hello] loaded');

  class Hello {
    getInfo() {
      return {
        id: "hello",
        name: "Hello",
        color1: "#FF6680",
        blocks: [
          {
            opcode: "hello",
            blockType: Scratch.BlockType.REPORTER,
            text: "hello",
          },
        ],
      };
    }

    hello() {
      return 'hello, world';
    }
  }

  Scratch.extensions.register(new Hello());
})(Scratch);

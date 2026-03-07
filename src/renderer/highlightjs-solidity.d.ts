declare module 'highlightjs-solidity' {
  import type { LanguageFn } from 'highlight.js';

  type SolidityPackage = {
    (hljs: unknown): void;
    solidity: LanguageFn;
    yul: LanguageFn;
  };

  const solidityPackage: SolidityPackage;
  export default solidityPackage;
}

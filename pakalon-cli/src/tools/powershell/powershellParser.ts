/**
 * PowerShell AST Parser
 *
 * Recursive-descent parser that produces a typed Abstract Syntax Tree from
 * PowerShell command strings. Designed as a pure function (no side effects)
 * so it is fully testable.
 *
 * Supported constructs:
 *   - Cmdlets (Verb-Noun), aliases, bare commands
 *   - Parameters (-Param, -ParamValue, :Value syntax)
 *   - Pipelines (|)
 *   - Script blocks { ... }
 *   - if / elseif / else
 *   - foreach / for / while / do-while / do-until
 *   - switch
 *   - try / catch / finally
 *   - function / filter / workflow definitions
 *   - Variables ($var, $var.Property, $var[0], ${var}, $env:VAR, @var splatting)
 *   - Strings (single-quoted, double-quoted with expansion)
 *   - Here-strings (@"..."@, @'...'@)
 *   - Arrays @(...)
 *   - Hashtables @{ ... }
 *   - Command invocation & cmd
 *   - Redirections (>, >>, 2>, 2>>)
 *   - Subexpressions $(...) and @(...)
 */

// ---------------------------------------------------------------------------
// AST Node Types
// ---------------------------------------------------------------------------

export type PowerShellNode =
  | CmdletCall
  | ScriptBlock
  | Pipeline
  | IfStatement
  | ForEachStatement
  | ForStatement
  | WhileStatement
  | DoWhileStatement
  | SwitchStatement
  | TryStatement
  | FunctionDefinition
  | Variable
  | StringLiteral
  | HereString
  | ArrayLiteral
  | HashtableLiteral
  | Redirection
  | BinaryOp
  | UnaryOp
  | CommandInvocation
  | Subexpression
  | NumberLiteral
  | BooleanLiteral
  | TypeLiteral
  | CommentNode;

/** Common fields on every node. */
interface BaseNode {
  type: string;
  start: number;
  end: number;
}

export interface CmdletCall extends BaseNode {
  type: "CmdletCall";
  verb: string;
  noun: string;
  module: string | null;
  parameters: ParameterNode[];
  arguments: PowerShellNode[];
}

export interface ParameterNode {
  name: string;
  value: PowerShellNode | null;
  switchParameter: boolean;
  dashCount: number;
}

export interface ScriptBlock extends BaseNode {
  type: "ScriptBlock";
  body: PowerShellNode[];
  isFilter: boolean;
}

export interface Pipeline extends BaseNode {
  type: "Pipeline";
  commands: PowerShellNode[];
}

export interface IfStatement extends BaseNode {
  type: "If";
  condition: PowerShellNode;
  then: ScriptBlock;
  elseIf: Array<{ condition: PowerShellNode; then: ScriptBlock }>;
  else: ScriptBlock | null;
}

export interface ForEachStatement extends BaseNode {
  type: "ForEach";
  variable: PowerShellNode | null;
  input: PowerShellNode;
  body: ScriptBlock;
}

export interface ForStatement extends BaseNode {
  type: "For";
  initializer: PowerShellNode | null;
  condition: PowerShellNode | null;
  iterator: PowerShellNode | null;
  body: ScriptBlock;
}

export interface WhileStatement extends BaseNode {
  type: "While";
  condition: PowerShellNode;
  body: ScriptBlock;
}

export interface DoWhileStatement extends BaseNode {
  type: "DoWhile";
  condition: PowerShellNode;
  body: ScriptBlock;
  isUntil: boolean;
}

export interface SwitchStatement extends BaseNode {
  type: "Switch";
  input: PowerShellNode | null;
  flags: string[];
  clauses: Array<{ pattern: PowerShellNode; body: PowerShellNode[] }>;
  default: PowerShellNode[] | null;
}

export interface TryStatement extends BaseNode {
  type: "Try";
  body: ScriptBlock;
  catches: Array<{ types: PowerShellNode[]; body: ScriptBlock }>;
  finally: ScriptBlock | null;
}

export interface FunctionDefinition extends BaseNode {
  type: "FunctionDef";
  name: string;
  modifiers: string[];
  parameters: ParameterNode[];
  body: ScriptBlock;
}

export interface Variable extends BaseNode {
  type: "Variable";
  name: string;
  scope: string | null;
  splatting: boolean;
  memberAccess: string[];
  indexAccess: PowerShellNode | null;
}

export interface StringLiteral extends BaseNode {
  type: "StringLiteral";
  value: string;
  expandable: boolean;
  segments: StringSegment[];
}

export type StringSegment =
  | { kind: "text"; value: string }
  | { kind: "variable"; name: string }
  | { kind: "expression"; expr: PowerShellNode };

export interface HereString extends BaseNode {
  type: "HereString";
  value: string;
  expandable: boolean;
  tag: string;
}

export interface ArrayLiteral extends BaseNode {
  type: "Array";
  elements: PowerShellNode[];
}

export interface HashtableLiteral extends BaseNode {
  type: "Hashtable";
  entries: Array<{ key: PowerShellNode; value: PowerShellNode }>;
}

export interface Redirection extends BaseNode {
  type: "Redirection";
  stream: number;
  operator: string;
  target: PowerShellNode;
}

export interface BinaryOp extends BaseNode {
  type: "BinaryOp";
  operator: string;
  left: PowerShellNode;
  right: PowerShellNode;
}

export interface UnaryOp extends BaseNode {
  type: "UnaryOp";
  operator: string;
  operand: PowerShellNode;
}

export interface CommandInvocation extends BaseNode {
  type: "CommandInvocation";
  command: PowerShellNode;
}

export interface Subexpression extends BaseNode {
  type: "Subexpression";
  body: PowerShellNode[];
}

export interface NumberLiteral extends BaseNode {
  type: "Number";
  value: number;
  raw: string;
}

export interface BooleanLiteral extends BaseNode {
  type: "Boolean";
  value: boolean;
}

export interface TypeLiteral extends BaseNode {
  type: "TypeLiteral";
  name: string;
}

export interface CommentNode extends BaseNode {
  type: "Comment";
  text: string;
}

// ---------------------------------------------------------------------------
// Side-effect types
// ---------------------------------------------------------------------------

export type SideEffectKind =
  | "file-write"
  | "file-delete"
  | "file-move"
  | "file-copy"
  | "registry-access"
  | "network-call"
  | "process-spawn"
  | "environment-modify"
  | "execution-policy"
  | "code-injection";

export interface SideEffect {
  kind: SideEffectKind;
  description: string;
  cmdlet?: string;
  position: number;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokenType =
  | "word"
  | "number"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "lbracket"
  | "rbracket"
  | "pipe"
  | "semicolon"
  | "ampersand"
  | "equals"
  | "comma"
  | "dot"
  | "colon"
  | "double-colon"
  | "comparison"
  | "redirection"
  | "string"
  | "here-string"
  | "variable"
  | "comment"
  | "newline"
  | "at"
  | "tilde"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "percent"
  | "exclamation"
  | "end-of-input";

interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

const COMPARISON_OPS = [
  "-eq",
  "-ne",
  "-gt",
  "-ge",
  "-lt",
  "-le",
  "-like",
  "-notlike",
  "-match",
  "-notmatch",
  "-contains",
  "-notcontains",
  "-in",
  "-notin",
  "-is",
  "-isnot",
  "-as",
  "-band",
  "-bor",
  "-bxor",
  "-bnot",
];

const REDIRECT_OPS = ["2>", "2>>", ">>", ">"];

class Tokeniser {
  private src: string;
  private pos: number;
  private tokens: Token[] = [];

  constructor(source: string) {
    this.src = source;
    this.pos = 0;
  }

  tokenise(): Token[] {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;

      // Newlines
      if (ch === "\r") {
        this.tokens.push({ type: "newline", value: "\r", start: this.pos, end: this.pos + 1 });
        this.pos++;
        if (this.pos < this.src.length && this.src[this.pos] === "\n") {
          this.tokens[this.tokens.length - 1]!.end = this.pos + 1;
          this.tokens[this.tokens.length - 1]!.value = "\r\n";
          this.pos++;
        }
        continue;
      }
      if (ch === "\n") {
        this.tokens.push({ type: "newline", value: "\n", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }

      // Comments
      if (ch === "#" && !this.inStringContext()) {
        const end = this.src.indexOf("\n", this.pos);
        const text = end === -1 ? this.src.slice(this.pos) : this.src.slice(this.pos, end);
        this.tokens.push({ type: "comment", value: text, start: this.pos, end: this.pos + text.length });
        this.pos += text.length;
        continue;
      }

      // Whitespace (outside strings)
      if (/\s/.test(ch) && !this.inStringContext()) {
        this.pos++;
        continue;
      }

      // Here-strings
      if (ch === "@" && !this.inStringContext()) {
        const hs = this.tryHereString();
        if (hs) {
          this.tokens.push(hs);
          continue;
        }
      }

      // Array / hashtable splatting prefix @  (but NOT here-string)
      if (ch === "@" && !this.inStringContext()) {
        // Check if next char starts a variable-like name or ( or {
        const next = this.src[this.pos + 1];
        if (next === "(" || next === "{") {
          // Handled by the expression parsers; emit @ as a token
          this.tokens.push({ type: "at", value: "@", start: this.pos, end: this.pos + 1 });
          this.pos++;
          continue;
        }
        // Otherwise it may be part of a variable name or splatting
      }

      // Variables
      if (ch === "$" && !this.inStringContext()) {
        const varTok = this.tryVariable();
        if (varTok) {
          this.tokens.push(varTok);
          continue;
        }
        // Bare $ – treat as word
        this.tokens.push({ type: "variable", value: "$", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }

      // Strings
      if (ch === '"' || ch === "'") {
        const str = this.tryString(ch);
        if (str) {
          this.tokens.push(str);
          continue;
        }
      }

      // Numbers
      if (/\d/.test(ch) || (ch === "." && this.pos + 1 < this.src.length && /\d/.test(this.src[this.pos + 1]!))) {
        const num = this.tryNumber();
        if (num) {
          this.tokens.push(num);
          continue;
        }
      }

      // Redirections (must check before single-char operators)
      const rem = this.src.slice(this.pos);
      let matchedRedirect = false;
      for (const op of REDIRECT_OPS) {
        if (rem.startsWith(op)) {
          this.tokens.push({ type: "redirection", value: op, start: this.pos, end: this.pos + op.length });
          this.pos += op.length;
          matchedRedirect = true;
          break;
        }
      }
      if (matchedRedirect) continue;

      // Two-char comparison operators
      if (ch === "-" && this.pos + 1 < this.src.length) {
        const word = this.readWord();
        if (COMPARISON_OPS.includes(word.toLowerCase())) {
          this.tokens.push({ type: "comparison", value: word, start: this.pos - word.length + 1, end: this.pos });
          continue;
        }
      }

      // Operators
      if (ch === "|") {
        this.tokens.push({ type: "pipe", value: "|", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === ";") {
        this.tokens.push({ type: "semicolon", value: ";", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "&") {
        this.tokens.push({ type: "ampersand", value: "&", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "=") {
        this.tokens.push({ type: "equals", value: "=", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === ",") {
        this.tokens.push({ type: "comma", value: ",", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === ".") {
        this.tokens.push({ type: "dot", value: ".", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "(") {
        this.tokens.push({ type: "lparen", value: "(", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === ")") {
        this.tokens.push({ type: "rparen", value: ")", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "{") {
        this.tokens.push({ type: "lbrace", value: "{", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "}") {
        this.tokens.push({ type: "rbrace", value: "}", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "[") {
        this.tokens.push({ type: "lbracket", value: "[", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "]") {
        this.tokens.push({ type: "rbracket", value: "]", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === ":") {
        if (this.pos + 1 < this.src.length && this.src[this.pos + 1] === ":") {
          this.tokens.push({ type: "double-colon", value: "::", start: this.pos, end: this.pos + 2 });
          this.pos += 2;
        } else {
          this.tokens.push({ type: "colon", value: ":", start: this.pos, end: this.pos + 1 });
          this.pos++;
        }
        continue;
      }
      if (ch === "+") {
        this.tokens.push({ type: "plus", value: "+", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "-") {
        this.tokens.push({ type: "minus", value: "-", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "*") {
        this.tokens.push({ type: "star", value: "*", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "/") {
        this.tokens.push({ type: "slash", value: "/", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "%") {
        this.tokens.push({ type: "percent", value: "%", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "!") {
        this.tokens.push({ type: "exclamation", value: "!", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }
      if (ch === "~") {
        this.tokens.push({ type: "tilde", value: "~", start: this.pos, end: this.pos + 1 });
        this.pos++;
        continue;
      }

      // Default: read a word token (handles -Parameter, bare names, etc.)
      const wordStart = this.pos;
      while (this.pos < this.src.length) {
        const c = this.src[this.pos]!;
        if (/\s/.test(c) || "|;(){}[],:=!<>+-*/%&#@\r\n".includes(c)) break;
        this.pos++;
      }
      if (this.pos > wordStart) {
        const w = this.src.slice(wordStart, this.pos);
        this.tokens.push({ type: "word", value: w, start: wordStart, end: this.pos });
      } else {
        // Advance to avoid infinite loop
        this.pos++;
      }
    }

    this.tokens.push({ type: "end-of-input", value: "", start: this.pos, end: this.pos });
    return this.tokens;
  }

  private inStringContext(): boolean {
    // Check if the last unclosed string context is active
    // We look backwards for an odd number of unescaped quotes
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < this.pos; i++) {
      const c = this.src[i]!;
      if (c === "'" && (i === 0 || this.src[i - 1] !== "`")) {
        inSingle = !inSingle;
      }
      if (c === '"' && (i === 0 || this.src[i - 1] !== "`")) {
        inDouble = !inDouble;
      }
    }
    return inSingle || inDouble;
  }

  private tryHereString(): Token | null {
    const rest = this.src.slice(this.pos);
    // @"..."@ or @'...'@
    const expandableMatch = rest.match(/^@"(?:[^"]|"")*?"@/);
    const literalMatch = rest.match(/^@'(?:[^']|'')*?'@/);
    const match = expandableMatch ?? literalMatch;
    if (match && match[0]) {
      const tok: Token = {
        type: "here-string",
        value: match[0],
        start: this.pos,
        end: this.pos + match[0].length,
      };
      this.pos += match[0].length;
      return tok;
    }
    return null;
  }

  private tryVariable(): Token | null {
    const rest = this.src.slice(this.pos);
    // ${script:var}, $env:PATH, $var, $global:var
    const match = rest.match(
      /^\$(?:\{[^}]+\}|[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?)/
    );
    if (match && match[0]) {
      const tok: Token = {
        type: "variable",
        value: match[0],
        start: this.pos,
        end: this.pos + match[0].length,
      };
      this.pos += match[0].length;
      return tok;
    }
    return null;
  }

  private tryString(quote: '"' | "'"): Token | null {
    const start = this.pos;
    if (this.src[this.pos] !== quote) return null;
    this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "`") {
        this.pos += 2;
        continue;
      }
      if (c === quote) {
        this.pos++;
        return { type: "string", value: this.src.slice(start, this.pos), start, end: this.pos };
      }
      this.pos++;
    }
    // Unterminated string – consume to end
    return { type: "string", value: this.src.slice(start), start, end: this.src.length };
  }

  private tryNumber(): Token | null {
    const rest = this.src.slice(this.pos);
    const match = rest.match(
      /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/
    );
    if (match && match[0]) {
      const tok: Token = {
        type: "number",
        value: match[0],
        start: this.pos,
        end: this.pos + match[0].length,
      };
      this.pos += match[0].length;
      return tok;
    }
    return null;
  }

  private readWord(): string {
    const start = this.pos;
    while (this.pos < this.src.length && /[a-zA-Z0-9_-]/.test(this.src[this.pos]!)) {
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos: number;
  private src: string;

  constructor(tokens: Token[], source: string) {
    this.tokens = tokens;
    this.pos = 0;
    this.src = source;
  }

  // -- Token helpers --

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "end-of-input", value: "", start: 0, end: 0 };
  }

  private peekAhead(offset: number): Token {
    return this.tokens[this.pos + offset] ?? { type: "end-of-input", value: "", start: 0, end: 0 };
  }

  private advance(): Token {
    const t = this.tokens[this.pos]!;
    this.pos++;
    return t;
  }

  private skipNewlines(): void {
    while (this.peek().type === "newline") {
      this.pos++;
    }
  }

  private skipSemicolons(): void {
    while (this.peek().type === "semicolon" || this.peek().type === "newline") {
      this.pos++;
    }
  }

  private expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new Error(`Expected ${type}, got ${t.type} at position ${t.start}: '${t.value}'`);
    }
    return this.advance();
  }

  private match(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.pos++;
      return true;
    }
    return false;
  }

  private matchValue(type: TokenType, value: string): boolean {
    const t = this.peek();
    if (t.type === type && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  // -- Top-level parsing --

  parseProgram(): PowerShellNode[] {
    const stmts: PowerShellNode[] = [];
    this.skipNewlines();
    while (this.peek().type !== "end-of-input") {
      const stmt = this.parseStatement();
      if (stmt) stmts.push(stmt);
      this.skipSemicolons();
    }
    return stmts;
  }

  parseStatement(): PowerShellNode | null {
    this.skipNewlines();
    const t = this.peek();
    if (t.type === "end-of-input") return null;

    // Keywords
    if (t.type === "word") {
      const lw = t.value.toLowerCase();
      if (lw === "if") return this.parseIf();
      if (lw === "foreach" || lw === "for") {
        // Distinguish foreach/for from ForEach-Object
        if (lw === "foreach") return this.parseForEach();
        if (lw === "for") return this.parseFor();
      }
      if (lw === "while") return this.parseWhile();
      if (lw === "do") return this.parseDoWhile();
      if (lw === "switch") return this.parseSwitch();
      if (lw === "try") return this.parseTry();
      if (lw === "function" || lw === "filter" || lw === "workflow") return this.parseFunctionDef();
    }

    return this.parsePipelineExpression();
  }

  // -- Pipeline expression --

  parsePipelineExpression(): PowerShellNode {
    let left = this.parseBinaryExpression();

    // Handle pipes
    while (this.peek().type === "pipe") {
      this.advance();
      this.skipNewlines();
      const right = this.parseBinaryExpression();
      const start = left.start;
      const end = right.end;

      if (left.type === "Pipeline") {
        (left as Pipeline).commands.push(right);
        left.end = end;
      } else {
        left = { type: "Pipeline", commands: [left, right], start, end };
      }
    }

    // Handle semicolons (statement separators)
    if (this.peek().type === "semicolon") {
      // Semicolons handled by caller
    }

    return left;
  }

  // -- Binary expressions (comparison, logical) --

  private parseBinaryExpression(): PowerShellNode {
    let left = this.parseUnaryExpression();

    const t = this.peek();
    if (t.type === "comparison") {
      const op = t.value;
      this.advance();
      this.skipNewlines();
      const right = this.parseUnaryExpression();
      left = {
        type: "BinaryOp",
        operator: op,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }

    return left;
  }

  private parseUnaryExpression(): PowerShellNode {
    const t = this.peek();
    if (t.type === "exclamation" || (t.type === "minus" && this.peekAhead(1).type !== "word")) {
      const op = t.value;
      this.advance();
      this.skipNewlines();
      const operand = this.parsePrimaryExpression();
      return {
        type: "UnaryOp",
        operator: op,
        operand,
        start: t.start,
        end: operand.end,
      };
    }
    return this.parsePrimaryExpression();
  }

  // -- Primary expressions --

  private parsePrimaryExpression(): PowerShellNode {
    this.skipNewlines();
    const t = this.peek();

    // Script block
    if (t.type === "lbrace") return this.parseScriptBlock(false);

    // Array @(...)
    if (t.type === "at" && this.peekAhead(1).type === "lparen") {
      return this.parseArrayLiteral();
    }
    // Hashtable @{...}
    if (t.type === "at" && this.peekAhead(1).type === "lbrace") {
      return this.parseHashtableLiteral();
    }

    // String
    if (t.type === "string") return this.parseStringLiteral();

    // Here-string
    if (t.type === "here-string") return this.parseHereString();

    // Variable
    if (t.type === "variable") return this.parseVariable();

    // Number
    if (t.type === "number") return this.parseNumber();

    // Subexpression $(...)
    if (t.type === "lparen") {
      // Could be a subexpression or just grouping – check context
      return this.parseSubexpression();
    }

    // Type literal [Type]
    if (t.type === "lbracket") {
      return this.parseTypeLiteral();
    }

    // Command / bare word / comparison
    if (t.type === "word" || t.type === "comparison" || t.type === "ampersand" || t.type === "minus") {
      return this.parseCommandExpression();
    }

    // Redirection
    if (t.type === "redirection") return this.parseRedirection(null);

    // Fallback – consume a token as word
    this.advance();
    return {
      type: "StringLiteral",
      value: t.value,
      expandable: false,
      segments: [{ kind: "text", value: t.value }],
      start: t.start,
      end: t.end,
    };
  }

  // -- Script block --

  private parseScriptBlock(isFilter: boolean): ScriptBlock {
    const lbrace = this.expect("lbrace");
    this.skipNewlines();
    const body: PowerShellNode[] = [];
    while (this.peek().type !== "rbrace" && this.peek().type !== "end-of-input") {
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
      this.skipSemicolons();
    }
    const rbrace = this.expect("rbrace");
    return {
      type: "ScriptBlock",
      body,
      isFilter,
      start: lbrace.start,
      end: rbrace.end,
    };
  }

  // -- Array literal @(...) --

  private parseArrayLiteral(): ArrayLiteral {
    const at = this.advance(); // @
    const lparen = this.expect("lparen");
    const elements = this.parseCommaSeparatedExpressions();
    const rparen = this.expect("rparen");
    return {
      type: "Array",
      elements,
      start: at.start,
      end: rparen.end,
    };
  }

  // -- Hashtable literal @{ ... } --

  private parseHashtableLiteral(): HashtableLiteral {
    const at = this.advance(); // @
    const lbrace = this.expect("lbrace");
    this.skipNewlines();
    const entries: Array<{ key: PowerShellNode; value: PowerShellNode }> = [];
    while (this.peek().type !== "rbrace" && this.peek().type !== "end-of-input") {
      const key = this.parsePrimaryExpression();
      this.skipNewlines();
      if (this.peek().type === "equals") {
        this.advance();
        this.skipNewlines();
        const value = this.parsePipelineExpression();
        entries.push({ key, value });
      } else {
        // Bare key without value
        entries.push({ key, value: { type: "BooleanLiteral", value: true, start: key.start, end: key.end } });
      }
      if (this.peek().type === "comma") this.advance();
      this.skipNewlines();
    }
    const rbrace = this.expect("rbrace");
    return {
      type: "Hashtable",
      entries,
      start: at.start,
      end: rbrace.end,
    };
  }

  // -- String literal --

  private parseStringLiteral(): StringLiteral {
    const tok = this.advance();
    const raw = tok.value;
    const expandable = raw[0] === '"';
    const value = raw.slice(1, -1); // strip quotes
    const segments = expandable ? this.parseExpandableString(value) : [{ kind: "text" as const, value }];
    return {
      type: "StringLiteral",
      value,
      expandable,
      segments,
      start: tok.start,
      end: tok.end,
    };
  }

  private parseExpandableString(inner: string): StringSegment[] {
    const segments: StringSegment[] = [];
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === "`" && i + 1 < inner.length) {
        // Escape sequence – treat next char as literal
        segments.push({ kind: "text", value: inner[i + 1]! });
        i += 2;
        continue;
      }
      if (inner[i] === "$") {
        // Variable or subexpression
        if (i + 1 < inner.length && inner[i + 1] === "(") {
          // Subexpression – simplified: just capture text
          const end = inner.indexOf(")", i + 2);
          const exprText = end === -1 ? inner.slice(i + 2) : inner.slice(i + 2, end);
          segments.push({
            kind: "expression",
            expr: {
              type: "Subexpression",
              body: [{ type: "StringLiteral", value: exprText, expandable: false, segments: [{ kind: "text", value: exprText }], start: i, end: i + exprText.length + 3 }],
              start: i,
              end: end === -1 ? inner.length : end + 1,
            },
          });
          i = end === -1 ? inner.length : end + 1;
          continue;
        }
        // Variable name
        const match = inner.slice(i).match(
          /^\$\{[^}]+\}|\$[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?/
        );
        if (match && match[0]) {
          segments.push({ kind: "variable", name: match[0].slice(1) }); // strip $
          i += match[0].length;
          continue;
        }
      }
      // Plain text
      let textEnd = i + 1;
      while (textEnd < inner.length && inner[textEnd] !== "$" && inner[textEnd] !== "`") {
        textEnd++;
      }
      segments.push({ kind: "text", value: inner.slice(i, textEnd) });
      i = textEnd;
    }
    return segments;
  }

  // -- Here-string --

  private parseHereString(): HereString {
    const tok = this.advance();
    const raw = tok.value;
    const expandable = raw[1] === '"';
    // @"..."@  or  @'...'@
    const value = raw.slice(2, -2).replace(/""/g, '"').replace(/''/g, "'");
    const tag = raw.slice(0, 2);
    return {
      type: "HereString",
      value,
      expandable,
      tag,
      start: tok.start,
      end: tok.end,
    };
  }

  // -- Variable --

  private parseVariable(): Variable {
    const tok = this.advance();
    const raw = tok.value;
    let name = raw.slice(1); // strip $
    let scope: string | null = null;
    let splatting = false;
    const memberAccess: string[] = [];
    let indexAccess: PowerShellNode | null = null;

    // Check for scope prefix (e.g. $global:var)
    const scopeMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(.+)/);
    if (scopeMatch && !["env", "global", "local", "private", "script", "using"].includes(scopeMatch[1]!.toLowerCase()) === false) {
      // Actually env: is a special drive, treat as scope
      if (["global", "local", "private", "script", "using"].includes(scopeMatch[1]!.toLowerCase())) {
        scope = scopeMatch[1]!;
        name = scopeMatch[2]!;
      }
    }

    // Check splatting (@ prefix handled in tokeniser as @var)
    // The raw token will be $var; @var is handled separately

    return {
      type: "Variable",
      name,
      scope,
      splatting,
      memberAccess,
      indexAccess,
      start: tok.start,
      end: tok.end,
    };
  }

  // -- Number --

  private parseNumber(): NumberLiteral {
    const tok = this.advance();
    const value = Number(tok.value);
    return {
      type: "Number",
      value: isNaN(value) ? 0 : value,
      raw: tok.value,
      start: tok.start,
      end: tok.end,
    };
  }

  // -- Subexpression --

  private parseSubexpression(): Subexpression {
    const lparen = this.expect("lparen");
    const body: PowerShellNode[] = [];
    while (this.peek().type !== "rparen" && this.peek().type !== "end-of-input") {
      body.push(this.parsePipelineExpression());
      if (this.peek().type === "comma") this.advance();
      this.skipNewlines();
    }
    const rparen = this.expect("rparen");
    return {
      type: "Subexpression",
      body,
      start: lparen.start,
      end: rparen.end,
    };
  }

  // -- Type literal [TypeName] --

  private parseTypeLiteral(): TypeLiteral {
    const lbracket = this.expect("lbracket");
    let name = "";
    let depth = 1;
    while (this.peek().type !== "end-of-input" && depth > 0) {
      if (this.peek().type === "lbracket") depth++;
      if (this.peek().type === "rbracket") {
        depth--;
        if (depth === 0) break;
      }
      name += this.advance().value;
    }
    const rbracket = this.expect("rbracket");
    return {
      type: "TypeLiteral",
      name: name.trim(),
      start: lbracket.start,
      end: rbracket.end,
    };
  }

  // -- Command / parameter parsing --

  private parseCommandExpression(): PowerShellNode {
    const first = this.peek();
    const isInvocation = first.type === "ampersand";
    if (isInvocation) {
      this.advance();
    }

    // Collect command name, parameters, and arguments
    const nameToken = this.peek();
    let commandName = "";
    let moduleName: string | null = null;

    // Handle dotted names: Module\Command or Module::Command
    if (nameToken.type === "word" || nameToken.type === "comparison" || nameToken.type === "minus") {
      this.advance();
      commandName = nameToken.value;
    } else if (nameToken.type === "variable") {
      // Variable command reference
      const v = this.parseVariable();
      if (isInvocation) {
        return {
          type: "CommandInvocation",
          command: v,
          start: first.start,
          end: v.end,
        };
      }
      return v;
    } else {
      // Not a recognizable command – return as a string
      this.advance();
      return {
        type: "StringLiteral",
        value: nameToken.value,
        expandable: false,
        segments: [{ kind: "text", value: nameToken.value }],
        start: nameToken.start,
        end: nameToken.end,
      };
    }

    // Check for Module\Cmd syntax
    if (commandName.includes("\\")) {
      const parts = commandName.split("\\", 2);
      moduleName = parts[0]!;
      commandName = parts[1]!;
    }

    // Parse parameters and positional arguments
    const parameters: ParameterNode[] = [];
    const args: PowerShellNode[] = [];

    while (this.peek().type !== "end-of-input" && this.peek().type !== "pipe" && this.peek().type !== "semicolon" && this.peek().type !== "newline") {
      const pt = this.peek();

      // Dash-prefixed parameter (-Param or -ParamValue)
      if (pt.type === "minus") {
        const saved = this.pos;
        this.advance();
        const paramName = this.peek();
        if (paramName.type === "word") {
          this.advance();
          const param: ParameterNode = {
            name: paramName.value,
            value: null,
            switchParameter: true,
            dashCount: 1,
          };

          // Check if next token is =, : or a value (not another parameter)
          const next = this.peek();
          if (next.type === "equals" || next.type === "colon") {
            this.advance();
            this.skipNewlines();
            param.value = this.parsePrimaryExpression();
            param.switchParameter = false;
          } else if (next.type !== "pipe" && next.type !== "semicolon" && next.type !== "newline" && next.type !== "end-of-input" && next.type !== "minus") {
            // Value parameter (space-separated)
            param.value = this.parsePrimaryExpression();
            param.switchParameter = false;
          }
          // else: switch parameter (no value)

          parameters.push(param);
          continue;
        } else {
          // Not a parameter name after dash – restore and parse as argument
          this.pos = saved;
        }
      }

      // Redirection
      if (pt.type === "redirection") {
        this.advance();
        const target = this.parsePrimaryExpression();
        const stream = pt.value.startsWith("2") ? 2 : 1;
        args.push({
          type: "Redirection",
          stream,
          operator: pt.value,
          target,
          start: pt.start,
          end: target.end,
        } as Redirection);
        continue;
      }

      // Script block argument
      if (pt.type === "lbrace") {
        args.push(this.parseScriptBlock(false));
        continue;
      }

      // Regular argument
      args.push(this.parsePrimaryExpression());
    }

    const cmdNode: CmdletCall = {
      type: "CmdletCall",
      verb: commandName.split("-", 2)[0]?.toLowerCase() ?? "",
      noun: commandName.split("-", 2)[1]?.toLowerCase() ?? "",
      module: moduleName,
      parameters,
      arguments: args,
      start: nameToken.start,
      end: this.peek().start,
    };

    if (isInvocation) {
      return {
        type: "CommandInvocation",
        command: cmdNode,
        start: first.start,
        end: cmdNode.end,
      };
    }

    return cmdNode;
  }

  // -- Redirection --

  private parseRedirection(target: PowerShellNode | null): Redirection {
    const tok = this.advance();
    if (!target) {
      target = this.parsePrimaryExpression();
    }
    const stream = tok.value.startsWith("2") ? 2 : 1;
    return {
      type: "Redirection",
      stream,
      operator: tok.value,
      target,
      start: tok.start,
      end: target.end,
    };
  }

  // -- If statement --

  private parseIf(): IfStatement {
    const ifTok = this.expect("word");
    this.skipNewlines();
    const condition = this.parsePipelineExpression();
    this.skipNewlines();
    const then = this.parseScriptBlock(false);
    this.skipNewlines();

    const elseIf: Array<{ condition: PowerShellNode; then: ScriptBlock }> = [];
    let elseBlock: ScriptBlock | null = null;

    while (this.peek().type === "word") {
      const kw = this.peek().value.toLowerCase();
      if (kw === "elseif") {
        this.advance();
        this.skipNewlines();
        const eifCond = this.parsePipelineExpression();
        this.skipNewlines();
        const eifThen = this.parseScriptBlock(false);
        elseIf.push({ condition: eifCond, then: eifThen });
        this.skipNewlines();
      } else if (kw === "else") {
        this.advance();
        this.skipNewlines();
        elseBlock = this.parseScriptBlock(false);
        this.skipNewlines();
        break;
      } else {
        break;
      }
    }

    return {
      type: "If",
      condition,
      then,
      elseIf,
      else: elseBlock,
      start: ifTok.start,
      end: (elseBlock ?? then).end,
    };
  }

  // -- ForEach --

  private parseForEach(): ForEachStatement {
    const kw = this.advance();
    this.skipNewlines();
    // foreach ($item in $collection) { ... }
    if (this.peek().type === "lparen") {
      this.advance();
      this.skipNewlines();
      const variable = this.parsePrimaryExpression();
      this.skipNewlines();
      const inTok = this.expect("word"); // "in"
      this.skipNewlines();
      const input = this.parsePipelineExpression();
      this.skipNewlines();
      this.expect("rparen");
      this.skipNewlines();
      const body = this.parseScriptBlock(false);
      return {
        type: "ForEach",
        variable,
        input,
        body,
        start: kw.start,
        end: body.end,
      };
    }
    // foreach ($item in $collection) without parens
    const variable = this.parsePrimaryExpression();
    this.skipNewlines();
    const inTok = this.expect("word"); // "in"
    this.skipNewlines();
    const input = this.parsePipelineExpression();
    this.skipNewlines();
    const body = this.parseScriptBlock(false);
    return {
      type: "ForEach",
      variable,
      input,
      body,
      start: kw.start,
      end: body.end,
    };
  }

  // -- For --

  private parseFor(): ForStatement {
    const kw = this.expect("word");
    this.skipNewlines();
    this.expect("lparen");
    this.skipNewlines();

    // initializer
    let initializer: PowerShellNode | null = null;
    if (this.peek().type !== "semicolon") {
      initializer = this.parsePipelineExpression();
    }
    this.expect("semicolon");
    this.skipNewlines();

    // condition
    let condition: PowerShellNode | null = null;
    if (this.peek().type !== "semicolon") {
      condition = this.parsePipelineExpression();
    }
    this.expect("semicolon");
    this.skipNewlines();

    // iterator
    let iterator: PowerShellNode | null = null;
    if (this.peek().type !== "rparen") {
      iterator = this.parsePipelineExpression();
    }
    this.skipNewlines();
    this.expect("rparen");
    this.skipNewlines();

    const body = this.parseScriptBlock(false);
    return {
      type: "For",
      initializer,
      condition,
      iterator,
      body,
      start: kw.start,
      end: body.end,
    };
  }

  // -- While --

  private parseWhile(): WhileStatement {
    const kw = this.expect("word");
    this.skipNewlines();
    const condition = this.parsePrimaryExpression();
    this.skipNewlines();
    const body = this.parseScriptBlock(false);
    return {
      type: "While",
      condition,
      body,
      start: kw.start,
      end: body.end,
    };
  }

  // -- Do-While / Do-Until --

  private parseDoWhile(): DoWhileStatement {
    const kw = this.expect("word");
    this.skipNewlines();
    const body = this.parseScriptBlock(false);
    this.skipNewlines();
    const endKw = this.expect("word");
    const isUntil = endKw.value.toLowerCase() === "until";
    this.skipNewlines();
    const condition = this.parsePrimaryExpression();
    return {
      type: "DoWhile",
      condition,
      body,
      isUntil,
      start: kw.start,
      end: condition.end,
    };
  }

  // -- Switch --

  private parseSwitch(): SwitchStatement {
    const kw = this.expect("word");
    this.skipNewlines();

    // Flags (-file, -regex, -wildcard, etc.)
    const flags: string[] = [];
    while (this.peek().type === "minus") {
      const saved = this.pos;
      this.advance();
      const f = this.peek();
      if (f.type === "word") {
        this.advance();
        flags.push(f.value.toLowerCase());
        continue;
      }
      this.pos = saved;
      break;
    }

    // Input expression
    let input: PowerShellNode | null = null;
    if (this.peek().type !== "lbrace") {
      input = this.parsePipelineExpression();
    }
    this.skipNewlines();
    this.expect("lbrace");
    this.skipNewlines();

    const clauses: Array<{ pattern: PowerShellNode; body: PowerShellNode[] }> = [];
    let defaultClause: PowerShellNode[] | null = null;

    while (this.peek().type !== "rbrace" && this.peek().type !== "end-of-input") {
      if (this.peek().type === "word" && this.peek().value.toLowerCase() === "default") {
        this.advance();
        this.skipNewlines();
        if (this.peek().type === "lbrace") {
          const sb = this.parseScriptBlock(false);
          defaultClause = sb.body;
        } else {
          const stmt = this.parseStatement();
          if (stmt) defaultClause = [stmt];
        }
        this.skipNewlines();
        continue;
      }

      const pattern = this.parsePipelineExpression();
      this.skipNewlines();
      let body: PowerShellNode[];
      if (this.peek().type === "lbrace") {
        const sb = this.parseScriptBlock(false);
        body = sb.body;
      } else {
        const stmt = this.parseStatement();
        body = stmt ? [stmt] : [];
      }
      clauses.push({ pattern, body });
      this.skipNewlines();
    }

    const rbrace = this.expect("rbrace");
    return {
      type: "Switch",
      input,
      flags,
      clauses,
      default: defaultClause,
      start: kw.start,
      end: rbrace.end,
    };
  }

  // -- Try / Catch / Finally --

  private parseTry(): TryStatement {
    const kw = this.expect("word");
    this.skipNewlines();
    const body = this.parseScriptBlock(false);
    this.skipNewlines();

    const catches: Array<{ types: PowerShellNode[]; body: ScriptBlock }> = [];
    let finallyBlock: ScriptBlock | null = null;

    while (this.peek().type === "word") {
      const k = this.peek().value.toLowerCase();
      if (k === "catch") {
        this.advance();
        this.skipNewlines();
        const types: PowerShellNode[] = [];
        if (this.peek().type === "lparen") {
          this.advance();
          while (this.peek().type !== "rparen" && this.peek().type !== "end-of-input") {
            types.push(this.parsePrimaryExpression());
            if (this.peek().type === "comma") this.advance();
          }
          this.expect("rparen");
          this.skipNewlines();
        }
        const catchBody = this.parseScriptBlock(false);
        catches.push({ types, body: catchBody });
        this.skipNewlines();
      } else if (k === "finally") {
        this.advance();
        this.skipNewlines();
        finallyBlock = this.parseScriptBlock(false);
        this.skipNewlines();
        break;
      } else {
        break;
      }
    }

    return {
      type: "Try",
      body,
      catches,
      finally: finallyBlock,
      start: kw.start,
      end: (finallyBlock ?? catches[catches.length - 1]?.body ?? body).end,
    };
  }

  // -- Function definition --

  private parseFunctionDef(): FunctionDefinition {
    const modToken = this.advance(); // function / filter / workflow
    const modifiers = [modToken.value.toLowerCase()];
    this.skipNewlines();

    // Optional: scope prefix (global:, local:, etc.)
    let name = "";
    if (this.peek().type === "word" && this.peekAhead(1).type === "colon") {
      modifiers.push(this.advance().value.toLowerCase());
      this.advance(); // colon
    }

    const nameTok = this.expect("word");
    name = nameTok.value;
    this.skipNewlines();

    // Optional parameters
    const parameters: ParameterNode[] = [];
    if (this.peek().type === "lparen") {
      this.advance();
      this.skipNewlines();
      while (this.peek().type !== "rparen" && this.peek().type !== "end-of-input") {
        const pt = this.peek();
        if (pt.type === "minus") {
          this.advance();
          const pName = this.expect("word");
          const param: ParameterNode = {
            name: pName.value,
            value: null,
            switchParameter: true,
            dashCount: 1,
          };
          this.skipNewlines();
          if (this.peek().type === "equals") {
            this.advance();
            this.skipNewlines();
            param.value = this.parsePrimaryExpression();
            param.switchParameter = false;
          } else if (this.peek().type !== "comma" && this.peek().type !== "rparen") {
            param.value = this.parsePrimaryExpression();
            param.switchParameter = false;
          }
          parameters.push(param);
        } else if (pt.type === "word") {
          this.advance();
          parameters.push({
            name: pt.value,
            value: null,
            switchParameter: false,
            dashCount: 0,
          });
        } else {
          this.advance();
        }
        if (this.peek().type === "comma") this.advance();
        this.skipNewlines();
      }
      this.expect("rparen");
      this.skipNewlines();
    }

    const body = this.parseScriptBlock(modifiers[0] === "filter");
    return {
      type: "FunctionDef",
      name,
      modifiers,
      parameters,
      body,
      start: modToken.start,
      end: body.end,
    };
  }

  // -- Comma-separated expression list --

  private parseCommaSeparatedExpressions(): PowerShellNode[] {
    const elements: PowerShellNode[] = [];
    if (this.peek().type === "rparen") return elements;
    elements.push(this.parsePipelineExpression());
    while (this.peek().type === "comma") {
      this.advance();
      this.skipNewlines();
      elements.push(this.parsePipelineExpression());
    }
    return elements;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a PowerShell command string into an AST.
 */
export function parsePowerShell(command: string): PowerShellNode {
  const tokeniser = new Tokeniser(command);
  const tokens = tokeniser.tokenise();
  const parser = new Parser(tokens, command);
  const stmts = parser.parseProgram();

  if (stmts.length === 0) {
    return {
      type: "ScriptBlock",
      body: [],
      isFilter: false,
      start: 0,
      end: 0,
    };
  }
  if (stmts.length === 1) return stmts[0]!;
  return {
    type: "ScriptBlock",
    body: stmts,
    isFilter: false,
    start: 0,
    end: command.length,
  };
}

// ---------------------------------------------------------------------------
// AST Visitor / Walker
// ---------------------------------------------------------------------------

export type VisitorResult = boolean | void | undefined;

export interface PowerShellVisitor {
  enter?: (node: PowerShellNode, parent: PowerShellNode | null) => VisitorResult;
  exit?: (node: PowerShellNode, parent: PowerShellNode | null) => void;
}

/**
 * Walk the AST depth-first, invoking enter/exit callbacks.
 * Return `false` from `enter` to skip children of that node.
 */
export function walkPowerShell(
  node: PowerShellNode,
  visitor: PowerShellVisitor,
  parent: PowerShellNode | null = null
): void {
  const skip = visitor.enter?.(node, parent);
  if (skip === false) return;

  switch (node.type) {
    case "CmdletCall":
      for (const arg of node.arguments) walkPowerShell(arg, visitor, node);
      for (const p of node.parameters) {
        if (p.value) walkPowerShell(p.value, visitor, node);
      }
      break;

    case "ScriptBlock":
      for (const stmt of node.body) walkPowerShell(stmt, visitor, node);
      break;

    case "Pipeline":
      for (const cmd of node.commands) walkPowerShell(cmd, visitor, node);
      break;

    case "If":
      walkPowerShell(node.condition, visitor, node);
      walkPowerShell(node.then, visitor, node);
      for (const ei of node.elseIf) {
        walkPowerShell(ei.condition, visitor, node);
        walkPowerShell(ei.then, visitor, node);
      }
      if (node.else) walkPowerShell(node.else, visitor, node);
      break;

    case "ForEach":
      if (node.variable) walkPowerShell(node.variable, visitor, node);
      walkPowerShell(node.input, visitor, node);
      walkPowerShell(node.body, visitor, node);
      break;

    case "For":
      if (node.initializer) walkPowerShell(node.initializer, visitor, node);
      if (node.condition) walkPowerShell(node.condition, visitor, node);
      if (node.iterator) walkPowerShell(node.iterator, visitor, node);
      walkPowerShell(node.body, visitor, node);
      break;

    case "While":
      walkPowerShell(node.condition, visitor, node);
      walkPowerShell(node.body, visitor, node);
      break;

    case "DoWhile":
      walkPowerShell(node.body, visitor, node);
      walkPowerShell(node.condition, visitor, node);
      break;

    case "Switch":
      if (node.input) walkPowerShell(node.input, visitor, node);
      for (const clause of node.clauses) {
        walkPowerShell(clause.pattern, visitor, node);
        for (const s of clause.body) walkPowerShell(s, visitor, node);
      }
      if (node.default) {
        for (const s of node.default) walkPowerShell(s, visitor, node);
      }
      break;

    case "Try":
      walkPowerShell(node.body, visitor, node);
      for (const c of node.catches) {
        for (const t of c.types) walkPowerShell(t, visitor, node);
        walkPowerShell(c.body, visitor, node);
      }
      if (node.finally) walkPowerShell(node.finally, visitor, node);
      break;

    case "FunctionDef":
      for (const p of node.parameters) {
        if (p.value) walkPowerShell(p.value, visitor, node);
      }
      walkPowerShell(node.body, visitor, node);
      break;

    case "Array":
      for (const el of node.elements) walkPowerShell(el, visitor, node);
      break;

    case "Hashtable":
      for (const entry of node.entries) {
        walkPowerShell(entry.key, visitor, node);
        walkPowerShell(entry.value, visitor, node);
      }
      break;

    case "Redirection":
      walkPowerShell(node.target, visitor, node);
      break;

    case "BinaryOp":
      walkPowerShell(node.left, visitor, node);
      walkPowerShell(node.right, visitor, node);
      break;

    case "UnaryOp":
      walkPowerShell(node.operand, visitor, node);
      break;

    case "CommandInvocation":
      walkPowerShell(node.command, visitor, node);
      break;

    case "Subexpression":
      for (const stmt of node.body) walkPowerShell(stmt, visitor, node);
      break;

    // Leaf nodes – nothing to recurse into
    case "Variable":
    case "StringLiteral":
    case "HereString":
    case "Number":
    case "Boolean":
    case "TypeLiteral":
    case "Comment":
      break;
  }

  visitor.exit?.(node, parent);
}

// ---------------------------------------------------------------------------
// extractCmdlets
// ---------------------------------------------------------------------------

/**
 * Return the list of cmdlet names invoked by a PowerShell command string.
 * Returns canonical "Verb-Noun" names (lower-cased) for known cmdlets and
 * the raw command name otherwise.
 */

const KNOWN_ALIASES: Record<string, string> = {
  ls: "get-childitem",
  dir: "get-childitem",
  gci: "get-childitem",
  cd: "set-location",
  sl: "set-location",
  chdir: "set-location",
  cat: "get-content",
  gc: "get-content",
  type: "get-content",
  pwd: "get-location",
  gl: "get-location",
  echo: "write-output",
  write: "write-output",
  rm: "remove-item",
  ri: "remove-item",
  del: "remove-item",
  erase: "remove-item",
  rd: "remove-item",
  rmdir: "remove-item",
  cp: "copy-item",
  ci: "copy-item",
  copy: "copy-item",
  mv: "move-item",
  mi: "move-item",
  move: "move-item",
  cls: "clear-host",
  clear: "clear-host",
  man: "get-help",
  help: "get-help",
  ps: "get-process",
  gps: "get-process",
  kill: "stop-process",
  spps: "stop-process",
  sleep: "start-sleep",
  where: "where-object",
  "?": "where-object",
  "%": "foreach-object",
  "foreach": "foreach-object",
  select: "select-object",
  sort: "sort-object",
  measure: "measure-object",
  diff: "compare-object",
  compare: "compare-object",
  sc: "set-content",
  ac: "add-content",
  clc: "clear-content",
  ni: "new-item",
  md: "new-item",
  mkdir: "new-item",
  ii: "invoke-item",
  iex: "invoke-expression",
  icm: "invoke-command",
  iwr: "invoke-webrequest",
  irm: "invoke-restmethod",
  curl: "invoke-webrequest",
  wget: "invoke-webrequest",
};

function resolveAlias(name: string): string {
  const lower = name.toLowerCase();
  return KNOWN_ALIASES[lower] ?? lower;
}

export function extractCmdlets(command: string): string[] {
  const ast = parsePowerShell(command);
  const cmdlets = new Set<string>();

  walkPowerShell(ast, {
    enter(node) {
      if (node.type === "CmdletCall") {
        const fullName = node.noun
          ? `${node.verb}-${node.noun}`
          : node.verb || (node as CmdletCall).arguments.length > 0
            ? ""
            : "";
        if (node.verb && node.noun) {
          cmdlets.add(resolveAlias(`${node.verb}-${node.noun}`));
        } else {
          // Bare command or alias
          const raw = node.module ? `${node.module}\\${node.verb}${node.noun ? "-" + node.noun : ""}` : node.verb;
          if (raw) cmdlets.add(resolveAlias(raw));
        }
      }
      if (node.type === "CommandInvocation") {
        // Nested command – will be visited when walking into it
      }
    },
  });

  return [...cmdlets];
}

// ---------------------------------------------------------------------------
// extractSideEffects
// ---------------------------------------------------------------------------

const FILE_WRITE_CMDLETS = new Set([
  "set-content",
  "add-content",
  "out-file",
  "export-csv",
  "export-clixml",
  "export-binarymaml",
  "set-item",
  "set-itemproperty",
  "new-item",
  "new-itemproperty",
  "remove-item",
  "rename-item",
  "move-item",
  "copy-item",
  "set-acl",
]);

const FILE_DELETE_CMDLETS = new Set(["remove-item", "clear-content"]);

const FILE_MOVE_CMDLETS = new Set(["move-item", "rename-item"]);

const FILE_COPY_CMDLETS = new Set(["copy-item"]);

const REGISTRY_CMDLETS = new Set([
  "get-itemproperty",
  "set-itemproperty",
  "new-itemproperty",
  "remove-itemproperty",
  "get-childitem",
]);

const NETWORK_CMDLETS = new Set([
  "invoke-webrequest",
  "invoke-restmethod",
  "invoke-webServiceProxy",
  "send-mailmessage",
  "new-object",
  "system.net.webclient",
]);

const PROCESS_SPAWN_CMDLETS = new Set([
  "start-process",
  "start-job",
  "start-threadjob",
  "invoke-command",
  "cmd",
  "powershell",
  "pwsh",
]);

const ENVIRONMENT_MODIFY_CMDLETS = new Set([
  "set-item",
  "set-content",
  "set-location",
]);

const EXECUTION_POLICY_CMDLETS = new Set(["set-executionpolicy"]);

const CODE_INJECTION_CMDLETS = new Set(["invoke-expression", "invoke-command"]);

/**
 * Detect side effects in a PowerShell command string.
 */
export function extractSideEffects(command: string): SideEffect[] {
  const ast = parsePowerShell(command);
  const effects: SideEffect[] = [];

  walkPowerShell(ast, {
    enter(node) {
      if (node.type === "CmdletCall") {
        const fullName = node.noun
          ? `${node.verb}-${node.noun}`
          : node.verb;
        const canonical = resolveAlias(fullName);

        // File writes
        if (FILE_WRITE_CMDLETS.has(canonical) && canonical !== "new-item") {
          // Check if targeting env: or registry drive
          const args = node.arguments.map(a => (a.type === "StringLiteral" ? a.value : "")).join(" ");
          if (canonical === "set-item" && /^env:|^%/.test(args)) {
            effects.push({ kind: "environment-modify", description: `Environment variable modification via ${canonical}`, cmdlet: canonical, position: node.start });
          } else if (canonical === "set-item" && /^(HKLM|HKCU|HKCR|HKU|HKCC):\\/.test(args)) {
            effects.push({ kind: "registry-access", description: `Registry modification via ${canonical}`, cmdlet: canonical, position: node.start });
          } else {
            effects.push({ kind: "file-write", description: `File/system write via ${canonical}`, cmdlet: canonical, position: node.start });
          }
        }

        if (FILE_DELETE_CMDLETS.has(canonical)) {
          effects.push({ kind: "file-delete", description: `File deletion via ${canonical}`, cmdlet: canonical, position: node.start });
        }

        if (FILE_MOVE_CMDLETS.has(canonical)) {
          effects.push({ kind: "file-move", description: `File move/rename via ${canonical}`, cmdlet: canonical, position: node.start });
        }

        if (FILE_COPY_CMDLETS.has(canonical)) {
          effects.push({ kind: "file-copy", description: `File copy via ${canonical}`, cmdlet: canonical, position: node.start });
        }

        // Registry
        if (REGISTRY_CMDLETS.has(canonical)) {
          const args = node.arguments.map(a => (a.type === "StringLiteral" ? a.value : "")).join(" ");
          if (/^(HKLM|HKCU|HKCR|HKU|HKCC):\\/.test(args)) {
            effects.push({ kind: "registry-access", description: `Registry access via ${canonical}`, cmdlet: canonical, position: node.start });
          }
        }

        // Network
        if (NETWORK_CMDLETS.has(canonical)) {
          effects.push({ kind: "network-call", description: `Network call via ${canonical}`, cmdlet: canonical, position: node.start });
        }

        // Process spawn
        if (PROCESS_SPAWN_CMDLETS.has(canonical)) {
          effects.push({ kind: "process-spawn", description: `Process spawn via ${canonical}`, cmdlet: canonical, position: node.start });
        }

        // Execution policy
        if (EXECUTION_POLICY_CMDLETS.has(canonical)) {
          effects.push({ kind: "execution-policy", description: `Execution policy change via ${canonical}`, cmdlet: canonical, position: node.start });
        }

        // Code injection
        if (CODE_INJECTION_CMDLETS.has(canonical)) {
          effects.push({ kind: "code-injection", description: `Code injection risk via ${canonical}`, cmdlet: canonical, position: node.start });
        }
      }

      // Redirect to file -> file write
      if (node.type === "Redirection" && node.stream === 1 && (node.operator === ">" || node.operator === ">>")) {
        effects.push({ kind: "file-write", description: `Output redirected via ${node.operator}`, position: node.start });
      }
    },
  });

  return effects;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  type CmdletCall as CmdletCallNode,
  type ScriptBlock as ScriptBlockNode,
  type Pipeline as PipelineNode,
  type IfStatement as IfStatementNode,
  type ForEachStatement as ForEachStatementNode,
  type ForStatement as ForStatementNode,
  type WhileStatement as WhileStatementNode,
  type DoWhileStatement as DoWhileStatementNode,
  type SwitchStatement as SwitchStatementNode,
  type TryStatement as TryStatementNode,
  type FunctionDefinition as FunctionDefinitionNode,
  type Variable as VariableNode,
  type StringLiteral as StringLiteralNode,
  type HereString as HereStringNode,
  type ArrayLiteral as ArrayLiteralNode,
  type HashtableLiteral as HashtableLiteralNode,
  type Redirection as RedirectionNode,
  type BinaryOp as BinaryOpNode,
  type UnaryOp as UnaryOpNode,
  type CommandInvocation as CommandInvocationNode,
  type Subexpression as SubexpressionNode,
  type NumberLiteral as NumberLiteralNode,
  type BooleanLiteral as BooleanLiteralNode,
  type TypeLiteral as TypeLiteralNode,
  type CommentNode as CommentNodeNode,
};

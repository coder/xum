import { describe, expect, test } from "bun:test";
import { describeCutOffBashScript } from "./bashScriptSyntax";

describe("describeCutOffBashScript", () => {
  test.each([
    ["grep for a lone double quote", `grep -F '"' file`],
    ["ANSI-C quote with an escaped single quote", `echo $'it\\'s'`],
    ["escaped quote outside quotes", `echo it\\'s`],
    ["quote closed on a later line", `echo "first\nsecond"`],
    ["quote inside a comment", `# don't\necho hi`],
    ["comment after a space", `echo hi #don't`],
    ["comment after a semicolon", `echo hi;#don't`],
    ["comment inside a subshell", `( ls # it's\n)`],
    ["$# is not a comment", `(echo $#)`],
    ["trailing backslash (bash accepts it)", `echo foo \\`],
    ["trailing backslash before a final newline", `echo foo \\\n`],
    ["backslash then newline mid-script", `echo foo \\\n  bar`],
    ["trailing pipe is left to bash", `ls |`],
    ["trailing && is left to bash", `ls &&`],
    ["heredoc body with stray quotes", `cat <<EOF\nit's "\n$(x\nEOF\necho ok`],
    ["two heredocs on one line", `cat <<A <<B\nit's\nA\n"\nB\necho ok`],
    ["heredoc that runs to end of input", `cat <<EOF\nit's`],
    ["heredoc ending in a newline without its terminator", `echo "$(cat <<''\nbody\n`],
    ["empty heredoc delimiter ends at the first empty line", `cat <<''\nit's\n\necho ok`],
    ["heredoc body starts on the line after the operator", `cat <<X # X\nit's\nX`],
    ["heredoc inside a command substitution", `x=$(cat <<EOF\nit's\nEOF\n)`],
    ["comment inside backticks stops at the backtick", "echo `ls # it's`"],
    ["single quotes inside unquoted parameter expansion", `echo \${x:-'a } b'}`],
    // Bash rejects this one, but a quote inside a double-quoted ${...} is not modelled: a miss.
    ["unmodelled quote inside double-quoted parameter expansion", `echo "\${x:-don't}"`],
    ["$' inside a double quote is literal", `echo "$'x"`],
    ["case pattern parenthesis", `case $x in a) echo "hi";; esac`],
    ["parenthesis inside a parameter expansion", `echo \${x%(*}`],
    ["comment in a command substitution that ends at the newline", `x=$(ls # note\n)`],
    ["indented terminator of a plain heredoc stays in the body", `cat <<EOF\n\tEOF\n'`],
    ["backslash kept in a quoted heredoc delimiter", `cat <<'E\\F'\nEF\nit's\nE\\F\n`],
    ["heredoc whose body follows a multi-line $(", `cat <<EOF; y=$(\necho hi\n)\nit's\nEOF\n`],
    ["no-break space before a hash is part of the word", `(echo a\u00a0#)`],
    ["carriage return before a hash is part of the word", `(echo a\r#)`],
  ])("accepts a complete script: %s", (_name, script) => {
    expect(describeCutOffBashScript(script)).toBeNull();
  });

  // Bash's quoting inside a double-quoted ${...} is not modelled, so a quote there gives up.
  test.each([
    `jq -n --arg v "\${val//'"'/\\\\\\"}" '{}'`,
    `echo "\${s//'"'/\\\\\\"}"`,
    `echo "\${x#'"'}"`,
    `echo "\${x:-'"'}"`,
    `echo "\${x:+'"'}"`,
    `echo "\${x%%'"'*}"`,
    `echo "\${x^^'"'}"`,
    `echo "\${x:-'$('}"`,
    "echo \"${x:-'`'}\"",
  ])("accepts a quote inside a double-quoted parameter expansion: %s", (script) => {
    expect(describeCutOffBashScript(script)).toBeNull();
  });

  // A case pattern's ) would close the enclosing frame, so a case there gives up.
  test.each([
    `echo "$(case $x in a) echo "it's";; esac)"`,
    `x="$(case $1 in\n  -h) printf "%s\\n" "it's help" ;;\nesac)"`,
  ])("accepts a case statement inside parentheses: %s", (script) => {
    expect(describeCutOffBashScript(script)).toBeNull();
  });

  // The middle column is the part of the message that names the open construct.
  test.each([
    ["plain single quote", "unterminated single quote", `grep 'x`],
    [
      "single quote inside unquoted parameter expansion",
      "unterminated single quote",
      `echo \${x:-'a}`,
    ],
    ["single quote after a mid-word hash", "unterminated single quote", `echo a# 'b`],
    ["single quote after a <<- terminator", "unterminated single quote", `cat <<-EOF\n\tEOF\n'`],
    ["double-quoted path", "unterminated double quote", `cd "$XUM_SCRATCH_DIR/x`],
    [
      "double quote whose escaped quote does not close it",
      "unterminated double quote",
      `echo "a \\"`,
    ],
    ["double quote ending in a backslash", "unterminated double quote", `echo "a \\`],
    ["double quote after a heredoc", "unterminated double quote", `cat <<A\nA\necho "x`],
    [
      "double quote after a quoted heredoc delimiter",
      "unterminated double quote",
      `cat <<'EOF'\nit's\nEOF\necho "x`,
    ],
    [
      "double quote after a backslash-quoted heredoc delimiter",
      "unterminated double quote",
      `cat <<\\EOF\nit's\nEOF\necho "x`,
    ],
    ["double quote after a here-string", "unterminated double quote", `cat <<<"here"\necho "x`],
    [
      "double quote after an input redirect",
      "unterminated double quote",
      `wc -l < "file"\necho "x`,
    ],
    [
      "double quote after a heredoc operator without a word",
      "unterminated double quote",
      `cat << \necho "x`,
    ],
    ["backtick", "unterminated backtick", "echo `ls"],
    ["backtick inside a double quote", "unterminated backtick", 'echo "`ls'],
    ["command substitution", "unclosed $(", `T=$(cat file`],
    ["command substitution inside a double quote", "unclosed $(", `echo "$(ls`],
    ["command substitution whose ) is in a comment", "unclosed $(", `echo $(ls # )`],
    ["subshell", "unclosed (", `( cd x`],
    ["process substitution", "unclosed (", `diff <(sort a`],
    ["parameter expansion", "unclosed ${", `echo \${x`],
    ["parameter expansion inside a double quote", "unclosed ${", `echo "\${x:-$(ls)`],
  ])("rejects an open construct: %s", (_name, construct, script) => {
    expect(describeCutOffBashScript(script)).toContain(construct);
  });

  test("names the open construct, the received length and the script", () => {
    expect(describeCutOffBashScript(`cd "$X`)).toBe(
      'arrived cut off: an unterminated double quote is open at end of input (received 6 characters: cd "$X). Re-send the whole script.'
    );
  });

  test("previews only the tail of a long script on one line", () => {
    const script = `echo start\n${"a".repeat(80)}\necho "end`;
    const message = describeCutOffBashScript(script);

    expect(message).toContain(`(received ${script.length} characters: …`);
    const preview = /characters: (.*)\)\. Re-send/.exec(message ?? "")?.[1] ?? "";
    expect(preview).toHaveLength(60);
    expect(preview).toEndWith(' echo "end');
    expect(message).not.toContain("\n");
  });

  test("keeps a script of exactly the preview limit whole", () => {
    const script = `echo "${"a".repeat(54)}`;
    expect(script).toHaveLength(60);
    expect(describeCutOffBashScript(script)).toContain(`characters: ${script})`);
  });
});

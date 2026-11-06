import { describe, expect, test } from "bun:test";
import {
  type CutOffShellConstruct,
  describeCutOffBashScript,
  findCutOffShellConstruct,
} from "./bashScriptSyntax";

describe("findCutOffShellConstruct", () => {
  test.each([
    ["single-quoted awk program", `awk '{print $1, "x"}' file`],
    ["single-quoted sed program with a double quote", `sed -e 's/"/x/g' file`],
    ["grep for a lone double quote", `grep -F '"' file`],
    ["double-quoted string with nested command substitution", `echo "$(ls "a b")"`],
    ["ANSI-C quote with an escaped single quote", `echo $'it\\'s'`],
    ["escaped quote inside a double-quoted string", `echo "a \\" b"`],
    ["escaped quote outside quotes", `echo it\\'s`],
    ["quote closed on a later line", `echo "first\nsecond"`],
    ["quote inside a comment", `# don't\necho hi`],
    ["hash inside a word is not a comment", `echo a#'b'`],
    ["comment after a space", `echo hi #don't`],
    ["$# is not a comment", `echo $# "x"`],
    ["${#var} is not a comment", `echo \${#var} "x"`],
    ["backslash inside a comment", `# trailing \\`],
    ["escaped trailing backslash", `echo foo \\\\`],
    ["backslash then newline mid-script", `echo foo \\\n  bar`],
    ["trailing pipe is left to bash", `ls |`],
    ["trailing && is left to bash", `ls &&`],
    ["heredoc body with stray quotes", `cat <<EOF\nit's "\n$(x\nEOF\necho ok`],
    ["quoted heredoc delimiter", `cat <<'EOF'\nit's\nEOF`],
    ["tab-stripped heredoc terminator", `cat <<-EOF\n\tit's\n\tEOF\necho "x"`],
    ["two heredocs on one line", `cat <<A <<B\nit's\nA\n"\nB\necho ok`],
    ["heredoc that runs to end of input", `cat <<EOF\nit's`],
    ["heredoc ending in a newline without its terminator", `echo "$(cat <<''\nbody\n`],
    ["empty heredoc delimiter ends at the first empty line", `cat <<''\nit's\n\necho ok`],
    ["heredoc line that ends with the delimiter character", `cat <<X # X\nit's\nX`],
    ["heredoc inside a command substitution", `x=$(cat <<EOF\nit's\nEOF\n)`],
    ["here-string", `cat <<<"here"; echo 'x'`],
    ["arithmetic shift", `echo $((1 << 2))`],
    ["input redirect", `wc -l < "file"`],
    ["comment inside backticks stops at the backtick", "echo `ls # it` 'x'"],
    ["single quotes inside unquoted parameter expansion", `echo \${x:-'a } b'}`],
    ["single quote inside double-quoted parameter expansion", `echo "\${x:-don't}"`],
    ["case pattern parenthesis", `case $x in a) echo "hi";; esac`],
    ["subshell and nested parameter expansion", `( cd "\${dir:-\${HOME}}" && ls )`],
    ["parenthesis inside a parameter expansion", `echo \${x%(*}`],
  ])("accepts a complete script: %s", (_name, script) => {
    expect(findCutOffShellConstruct(script)).toBeNull();
  });

  test.each<[CutOffShellConstruct, string]>([
    ["single-quote", `grep 'x`],
    ["single-quote", `echo $'it\\'s`],
    ["single-quote", `echo \${x:-'a}`],
    ["single-quote", `echo a# 'b`],
    ["double-quote", `cd "$XUM_SCRATCH_DIR/x`],
    ["double-quote", `echo "a \\"`],
    ["double-quote", `echo "a \\`],
    ["double-quote", `cat <<A\nA\necho "x`],
    ["double-quote", `cat <<-A\n\tA\necho "x`],
    ["double-quote", `cat <<A <<B\na\nA\nb\nB\necho "x`],
    ["backtick", "echo `ls"],
    ["backtick", 'echo "`ls'],
    ["command-substitution", `T=$(cat file`],
    ["command-substitution", `echo "$(ls`],
    ["command-substitution", `echo $(ls # )`],
    ["subshell", `( cd x`],
    ["subshell", `diff <(sort a`],
    ["parameter-expansion", `echo \${x`],
    ["parameter-expansion", `echo "\${x:-$(ls)`],
    ["line-continuation", `echo foo \\`],
    ["line-continuation", `echo foo \\\n`],
  ])("reports an open %s", (construct, script) => {
    expect(findCutOffShellConstruct(script)).toBe(construct);
  });

  test("a comment in a command substitution ends at the newline, not the parenthesis", () => {
    expect(findCutOffShellConstruct(`x=$(ls # note\n)`)).toBeNull();
    expect(findCutOffShellConstruct(`x=$(ls # note\n`)).toBe("command-substitution");
  });

  test("an indented terminator only ends a <<- heredoc", () => {
    expect(findCutOffShellConstruct(`cat <<EOF\n\tEOF\n'`)).toBeNull();
    expect(findCutOffShellConstruct(`cat <<-EOF\n\tEOF\n'`)).toBe("single-quote");
  });

  test("a heredoc operator without a word does not swallow the script", () => {
    expect(findCutOffShellConstruct(`cat << \necho "x`)).toBe("double-quote");
  });
});

describe("describeCutOffBashScript", () => {
  test("returns null for a complete script", () => {
    expect(describeCutOffBashScript(`echo "done"`)).toBeNull();
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

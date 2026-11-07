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
    ["comment after an escaped backslash and a space", `echo a\\\\ #'x\n`],
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
    ["escaped backtick in a backtick comment", "x=`\n# a \\` and a ' quote\n`\n"],
    ["escaped backtick in a backtick comment before the closer", "echo `# hi \\` there 'x\n`\n"],
    ["escaped backslash before a backtick closer in a comment", "echo `ls # a \\\\` 'x'\n"],
    // Bash parses the text inside backticks only when it runs.
    ["arithmetic shift then a later line", `echo $((1 << 2))\necho ok\n`],
    ["heredoc on a line after arithmetic", `echo $((1 << 2))\ncat <<EOF\nit's\nEOF\n`],
    ["arithmetic command with a shift", `((x = 1 << 2))\necho ok\n`],
    ["subshell right inside a command substitution", `x=$((cd /; ls) | wc -l)\n`],
    ["unbalanced quote inside backticks", "echo `ls 'x`; echo ok\n"],
    ["heredoc inside backticks", "x=`cat <<EOF\nit's\nEOF\n`\n"],
    ["single quotes inside unquoted parameter expansion", `echo \${x:-'a } b'}`],
    // Bash rejects this one, but a quote inside a double-quoted ${...} is not modelled: a miss.
    ["unmodelled quote inside double-quoted parameter expansion", `echo "\${x:-don't}"`],
    ["$' inside a double quote is literal", `echo "$'x"`],
    ["case pattern parenthesis", `case $x in a) echo "hi";; esac`],
    ["parenthesis inside a parameter expansion", `echo \${x%(*}`],
    ["comment in a command substitution that ends at the newline", `x=$(ls # note\n)`],
    ["indented terminator of a plain heredoc stays in the body", `cat <<EOF\n\tEOF\n'`],
    ["backslash kept in a quoted heredoc delimiter", `cat <<'E\\F'\nEF\nit's\nE\\F\n`],
    // Bash decodes these delimiters to EOF; the scanner does not model $'' or $"" there.
    ["ANSI-C quoted heredoc delimiter", `cat <<$'EOF'\nhi\n$EOF\nit's\nEOF\n`],
    ["locale-quoted heredoc delimiter", `cat <<$"EOF"\nhi\n$EOF\nit's\nEOF\n`],
    // A backslash inside a quoted delimiter is not modelled, so the scan gives up.
    ["escaped quote in a double-quoted delimiter", 'cat <<"E\\"OF"\n$(cut\nE"OF\n'],
    ["backslash in a single-quoted delimiter", "cat <<'E\\'OF'\n$(cut\nE\\'OF\n"],
    ["double-quoted delimiter look-alike line", 'cat <<"E\\"OF"\nE\\\necho "unclosed\n'],
    ["single-quoted delimiter look-alike line", "cat <<'E\\'OF'\nE\\\necho 'unclosed\n"],
    // A trailing backslash joins the next line into the word, so bash's delimiter is the
    // joined word (`EOF`) while the scanner reads only the part before the newline.
    [
      "heredoc delimiter continued on the next line",
      "cat <<EO\\\nF\nEO\nit's here\nEOF\necho done\n",
    ],
    [
      "continued heredoc delimiter with no look-alike body line",
      "cat <<EO\\\nF\nit's here\nEOF\necho done\n",
    ],
    [
      "continued heredoc delimiter after <<- with tabbed lines",
      "cat <<-EO\\\nF\n\tit's here\n\tEOF\necho done\n",
    ],
    [
      "continued heredoc delimiter inside a command substitution",
      "x=$(cat <<EO\\\nF\nit's here\nEOF\n)\necho done\n",
    ],
    // Bash removes the quoting of a delimiter word and expands nothing in it, so an
    // escaped word means `AB` and the scanner models both forms.
    ["escaped heredoc delimiter word", "cat <<A\\B\nit's here\nAB\necho done\n"],
    ["variable heredoc delimiter word", "D=EOF\ncat <<$D\nit's\n$D\necho done\n"],
    // Bash ends the body at a backtick delimiter as written; the scanner gives up on it.
    ["backtick heredoc delimiter", "cat <<`echo EOF`\nit's\n`echo EOF`\n"],
    ["backtick heredoc delimiter after <<-", "cat <<-`echo EOF`\n\tit's\n\t`echo EOF`\n"],
    ["backtick heredoc delimiter after a blank", "cat << `echo EOF`\nit's\n`echo EOF`\n"],
    [
      "backtick heredoc delimiter inside a command substitution",
      "x=$(cat <<`echo EOF`\n${x\n`echo EOF`\n)\n",
    ],
    ["backtick inside a heredoc delimiter word", "cat <<x`y`\nx\nit's\nx`y`\n"],
    ["heredoc whose body follows a multi-line $(", `cat <<EOF; y=$(\necho hi\n)\nit's\nEOF\n`],
    ["no-break space before a hash is part of the word", `(echo a\u00a0#)`],
    ["carriage return before a hash is part of the word", `(echo a\r#)`],
    // A ( inside an open [ is part of an array subscript, not a subshell.
    ["parenthesis inside an array subscript", `declare -A a; a[foo(]=x\n`],
    ["command substitution inside an array subscript", `declare -A a; a[$(echo b)]=1\n`],
    ["closing parenthesis inside an array subscript", `declare -A a; a[x)y]=z\n`],
    ["parenthesis inside an array subscript at the start of the script", `x[(]=1\n`],
    ["parenthesis after a nested bracket pair in a subscript", `declare -A a; a[b[x]y(]=1\n`],
    // Bash rejects this, but a ( inside an open [ is not modelled: a miss.
    ["unmodelled parenthesis after a leading open bracket", `[x(]\n`],
    // A `)` that ends a command, not a word, leaves a following # a comment.
    ["comment after a case pattern", `case $x in\n a) # it's fine\n  ;;\nesac\n`],
    ["comment after a space past a command substitution", `x=$(date) # it's fine\n`],
    ["hash right after an arithmetic command", `((i=1))#'cut\n`],
    ["hash right after a subshell", `(cd /)#'cut\n`],
    ["hash right after a command substitution closes an arithmetic command", `((x=$(a)))#'cut\n`],
    ["word that goes on after a command substitution", `x=$(date)y='ok'\n`],
    ["comment inside an array assignment", `x=(a # it's a comment\n b)\n`],
    // Bash rejects these, but `x=((` and a process substitution's word are not modelled: misses.
    ["unmodelled hash after an assignment of ((", `x=((1))#'cut\n`],
    ["unmodelled hash after a process substitution", `cat <(echo hi)#'cut\n`],
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
    ["hash as the second character of the script", "unterminated single quote", `a#'x`],
    ["hash after an escaped space", "unterminated single quote", `echo foo\\ #'cut\n`],
    ["hash after an escaped semicolon", "unterminated single quote", `echo a\\;#'b`],
    ["hash after an escaped parenthesis", "unterminated single quote", `echo a\\(#'b`],
    ["hash after a line continuation", "unterminated single quote", `echo a\\\n#'x\n`],
    ["single quote after a <<- terminator", "unterminated single quote", `cat <<-EOF\n\tEOF\n'`],
    ["double-quoted path", "unterminated double quote", `cd "$XUM_SCRATCH_DIR/x`],
    [
      "double quote whose escaped quote does not close it",
      "unterminated double quote",
      `echo "a \\"`,
    ],
    ["double quote ending in a backslash", "unterminated double quote", `echo "a \\`],
    ["double quote after a heredoc", "unterminated double quote", `cat <<A\nA\necho "x`],
    // Bash does not expand the delimiter word, so the body ends at the literal `$D` line
    // and the quote after it is a real cut. bash -n exits 2 on this script.
    [
      "single quote after a heredoc with a variable word",
      "unterminated single quote",
      "D=EOF\ncat <<$D\nbody\n$D\necho 'cut\n",
    ],
    [
      "double quote after a double-quoted delimiter",
      "unterminated double quote",
      'cat <<"EOF"\nEOF\necho "unclosed\n',
    ],
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
      "single quote after a heredoc with an unclosed quote in its body",
      "unterminated single quote",
      `cat <<EOF\nit's\nEOF\necho 'cut\n`,
    ],
    [
      "single quote after a quoted delimiter holding backticks",
      "unterminated single quote",
      "cat <<\"a`b`c\"\nit's\na`b`c\necho 'cut\n",
    ],
    [
      "single quote after a delimiter of escaped backticks",
      "unterminated single quote",
      "cat <<\\`cmd\\`\nit's\n`cmd`\necho 'cut\n",
    ],
    [
      "single quote after a here-string of a backtick command",
      "unterminated single quote",
      "cat <<< `echo hi`\necho 'cut\n",
    ],
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
    [
      "backtick whose comment has only an escaped backtick",
      "unterminated backtick",
      "echo `# hi \\` there",
    ],
    ["command substitution", "unclosed $(", `T=$(cat file`],
    ["command substitution inside a double quote", "unclosed $(", `echo "$(ls`],
    ["command substitution whose ) is in a comment", "unclosed $(", `echo $(ls # )`],
    ["subshell", "unclosed (", `( cd x`],
    [
      "hash right after a command substitution",
      "unterminated single quote",
      `value=$(printf ok)#'cut`,
    ],
    [
      "apostrophe in a hash word after a command substitution",
      "unterminated single quote",
      `x=$(date)# comment with apostrophe's\n`,
    ],
    [
      "hash right after an argument's substitution",
      "unterminated single quote",
      `echo $(date)#'cut\n`,
    ],
    ["hash right after arithmetic expansion", "unterminated single quote", `x=$((1))#'cut\n`],
    ["hash right after an array assignment", "unterminated single quote", `x=(a b)#'cut\n`],
    ["hash right after an array append", "unterminated single quote", `x+=(a b)#'cut\n`],
    [
      "double quote after an arithmetic shift",
      "unterminated double quote",
      `echo $((1 << 2))\necho "cut\n`,
    ],
    [
      "double quote after a heredoc that follows arithmetic",
      "unterminated double quote",
      `echo $((1 << 2))\ncat <<EOF\nit's\nEOF\necho "x`,
    ],
    [
      "double quote after an arithmetic command",
      "unterminated double quote",
      `(( x <<= 1 ))\necho "cut`,
    ],
    [
      "double quote after nested arithmetic parentheses",
      "unterminated double quote",
      `echo $(( (1 << 2) + 1 ))\necho "cut`,
    ],
    ["parenthesis left open inside arithmetic", "unclosed (", `echo $((1 + (2`],
    ["subshell after a closed array subscript", "unclosed (", `a[x]=1; (cd x`],
    ["subshell right after a closed bracket in the same word", "unclosed (", `a[x](cd y`],
    ["process substitution", "unclosed (", `diff <(sort a`],
    ["parameter expansion", "unclosed ${", `echo \${x`],
    ["parameter expansion inside a double quote", "unclosed ${", `echo "\${x:-$(ls)`],
  ])("rejects an open construct: %s", (_name, construct, script) => {
    expect(describeCutOffBashScript(script)).toContain(construct);
  });

  test("names the open construct and the received length, never the script", () => {
    const script = `curl -H "Authorization: Bearer sk-SECRET`;

    expect(describeCutOffBashScript(script)).toBe(
      `arrived cut off: an unterminated double quote is open at end of input (received ${script.length} characters). Re-send the whole script.`
    );
  });
});

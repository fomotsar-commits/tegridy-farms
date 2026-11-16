// The only way a password reaches the signer: typed by hand at a terminal, echoed as
// nothing. Never an environment variable, a command-line argument, a file or a pipe:
// those end up in shell history, process listings, crash dumps and other programs' reach.

export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(new Error('the password is only read from a terminal, typed by hand (never from a pipe, a file, the environment or the command line). On Windows run this from PowerShell or Windows Terminal; in Git Bash, put winpty in front of the command.')); // PIN:K.tty
  output.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let typed = '';
    const done = (fn, value) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      fn(value);
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(resolve, typed);
        if (ch === '\u0003') return done(reject, new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') {
          typed = typed.slice(0, -1);
          continue;
        }
        if (ch < ' ') continue;
        typed += ch;
      }
      return undefined;
    }
    input.on('data', onData);
  });
}

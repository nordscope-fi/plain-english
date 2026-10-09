var asciiAlpha = regexCheck(/[A-Za-z]/);
var asciiAlphanumeric = regexCheck(/[\dA-Za-z]/);
var asciiAtext = regexCheck(/[#-'*+\--9=?A-Z^-~]/);
function asciiControl(code) {
  return (
    code !== null && (code < 32 || code === 127)
  );
}
var asciiDigit = regexCheck(/\d/);
var asciiHexDigit = regexCheck(/[\dA-Fa-f]/);
var asciiPunctuation = regexCheck(/[!-/:-@[-`{-~]/);
function markdownLineEnding(code) {
  return code !== null && code < -2;
}
function markdownLineEndingOrSpace(code) {
  return code !== null && (code < 0 || code === 32);
}
function markdownSpace(code) {
  return code === -2 || code === -1 || code === 32;
}
var unicodePunctuation = regexCheck(/\p{P}|\p{S}/u);
var unicodeWhitespace = regexCheck(/\s/);
function regexCheck(regex) {
  return check;
  function check(code) {
    return code !== null && code > -1 && regex.test(String.fromCharCode(code));
  }
}

function factorySpace(effects, ok, type, max) {
  const limit = max ? max - 1 : Infinity;
  let size = 0;
  return start;
  function start(code) {
    if (markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return ok(code);
  }
  function prefix(code) {
    if (markdownSpace(code) && size++ < limit) {
      effects.consume(code);
      return prefix;
    }
    effects.exit(type);
    return ok(code);
  }
}
function factorySpaceMinMax(effects, ok, nok, type, min, max) {
  let size = 0;
  return start;
  function start(code) {
    if (max > 0 && markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return after(code);
  }
  function prefix(code) {
    if (markdownSpace(code) && size < max) {
      effects.consume(code);
      size++;
      return prefix;
    }
    effects.exit(type);
    return after(code);
  }
  function after(code) {
    return size >= min ? ok(code) : nok(code);
  }
}

export {
  asciiAlpha,
  asciiAlphanumeric,
  asciiAtext,
  asciiControl,
  asciiDigit,
  asciiHexDigit,
  asciiPunctuation,
  markdownLineEnding,
  markdownLineEndingOrSpace,
  markdownSpace,
  unicodePunctuation,
  unicodeWhitespace,
  factorySpace,
  factorySpaceMinMax
};

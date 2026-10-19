// Small helpers the rule packs share for reading one simple command's argv.
//
// A pack rule takes a simple command {argv, assigns, redirects, dir} and
// returns null or a hit made with block(rule, why, instead).
//
// Tests: node --test test/guard/engine.test.mjs

/** A rule hit: the engine turns it into a block message. */
export const block = (rule, why, instead) => ({ rule, why, instead });

/** The option words of argv (everything after argv[0] that starts with -). */
export const options = (argv) => argv.slice(1).filter((a) => a.startsWith('-'));

/** True when any of `names` is given, as `--name` or `--name=value`. */
export const hasFlag = (argv, ...names) => options(argv).some((a) => names.includes(a.split('=')[0]));

/** The value of option `name` (`--name value` or `--name=value`), or undefined. */
export function flagValue(argv, name) {
  for (let k = 1; k < argv.length; k += 1) {
    if (argv[k] === name) return argv[k + 1];
    if (argv[k].startsWith(`${name}=`)) return argv[k].slice(name.length + 1);
  }
  return undefined;
}

/** The non-option words after argv[0], skipping the values of `valueOptions`; everything after `--` counts. */
export function positionals(argv, valueOptions = []) {
  const out = [];
  for (let k = 1; k < argv.length; k += 1) {
    const a = argv[k];
    if (a === '--') {
      out.push(...argv.slice(k + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      if (valueOptions.includes(a)) k += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);

/** `--config-env=key=ENVVAR` as the config setting `key=`<unresolvable>, since the value comes from the environment. */
const CONFIG_ENV_SENTINEL = '\u0000env';
const configEnvSetting = (spec) => {
  const key = String(spec).split('=')[0];
  return key === '' ? '' : `${key}=${CONFIG_ENV_SENTINEL}`;
};

/**
 * A git argv split into its config settings (from -c and --config-env, spaced
 * or attached), the subcommand and the subcommand's arguments. A --config-env
 * setting carries a sentinel value, because its real value is an env variable.
 */
export function splitGit(argv) {
  const configs = [];
  let k = 1;
  while (k < argv.length && argv[k].startsWith('-') && argv[k] !== '--') {
    const a = argv[k];
    if (a === '-c') {
      if (argv[k + 1] !== undefined) configs.push(argv[k + 1]);
      k += 2;
    } else if (a.length > 2 && a.startsWith('-c')) {
      configs.push(a.slice(2));
      k += 1;
    } else if (a === '--config-env') {
      if (argv[k + 1] !== undefined) configs.push(configEnvSetting(argv[k + 1]));
      k += 2;
    } else if (a.startsWith('--config-env=')) {
      configs.push(configEnvSetting(a.slice('--config-env='.length)));
      k += 1;
    } else if (GIT_GLOBAL_VALUE_OPTS.has(a)) {
      k += 2;
    } else k += 1;
  }
  return { configs, sub: argv[k], args: argv.slice(k + 1) };
}

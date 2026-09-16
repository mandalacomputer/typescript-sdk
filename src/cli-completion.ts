import { CliError, COMMANDS, GLOBAL_FLAGS } from './cli-options.js';

/** Shell scripts are pure output and use only static words from the inventory. */
export function completion(shell: string): string {
  if (!['bash', 'zsh', 'fish'].includes(shell))
    throw new CliError('invalid_arguments', 'completion shell must be bash, zsh or fish');
  const contexts = new Map<string, Set<string>>();
  for (const command of COMMANDS) {
    const parts = command.path.split(' ');
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(' ');
      if (!contexts.has(prefix)) contexts.set(prefix, new Set());
      contexts.get(prefix)!.add(parts[i]!);
    }
    contexts.set(
      command.path,
      new Set(
        [...GLOBAL_FLAGS, ...command.flags].flatMap((f) => [
          `--${f.name}`,
          ...(f.alias ? [`-${f.alias}`] : []),
        ]),
      ),
    );
  }
  for (const [context, candidates] of contexts) {
    for (const flag of GLOBAL_FLAGS) candidates.add(`--${flag.name}`);
    for (const choices of Object.values(
      COMMANDS.find((c) => c.path === context)?.argumentChoices ?? {},
    )) {
      for (const choice of choices) candidates.add(choice);
    }
  }
  if (shell === 'fish') {
    const globals = GLOBAL_FLAGS.flatMap((f) => [
      `--${f.name}`,
      ...(f.alias ? [`-${f.alias}`] : []),
    ]);
    const contextPatterns = [...contexts.keys()]
      .filter(Boolean)
      .map((key) => `'${key}'`)
      .join(' ');
    const matcher = `function __mandala_matches_context\n  set -l context ''\n  for word in (commandline -opc)[2..-1]\n    if contains -- "$word" ${globals.map((flag) => `'${flag}'`).join(' ')}\n      continue\n    end\n    if test "$word" = '--'\n      break\n    end\n    set -l candidate "$word"\n    if test -n "$context"\n      set candidate "$context $word"\n    end\n    switch "$candidate"\n      case ${contextPatterns}\n        set context "$candidate"\n    end\n  end\n  test "$context" = "$argv[1]"\nend\n`;
    return `${matcher}${[...contexts]
      .flatMap(([context, candidates]) =>
        [...candidates].map((word) => {
          const condition = `__mandala_matches_context '${context}'`;
          const spec = [
            ...GLOBAL_FLAGS,
            ...(COMMANDS.find((c) => c.path === context)?.flags ?? []),
          ].find((f) => word === `--${f.name}` || word === `-${f.alias}`);
          const values =
            spec?.type !== 'boolean' && spec
              ? ` -r${spec.choices ? ` -a '${spec.choices.join(' ')}'` : ''}`
              : '';
          return `complete -c mandala -f -n "${condition}" ${word.startsWith('--') ? `-l ${word.slice(2)}` : word.startsWith('-') ? `-s ${word.slice(1)}` : `-a '${word}'`}${values}`;
        }),
      )
      .join('\n')}\n`;
  }
  const cases = [...contexts]
    .map(
      ([context, candidates]) => `    '${context}') candidates='${[...candidates].join(' ')}' ;;`,
    )
    .join('\n');
  const valueCases = COMMANDS.flatMap((c) =>
    c.flags
      .filter((f) => f.choices)
      .map((f) => `    '${c.path}|--${f.name}') candidates='${f.choices!.join(' ')}' ;;`),
  ).join('\n');
  const transitions = [...contexts.keys()]
    .filter(Boolean)
    .map((key) => `'${key}'`)
    .join('|');
  if (shell === 'bash')
    return `_mandala_complete() {\n  local context='' word candidate candidates='' prev='' i\n  for ((i=1; i<COMP_CWORD; i++)); do\n    word="\${COMP_WORDS[i]}"\n    candidate="\${context:+$context }$word"\n    case "$candidate" in ${transitions}) context="$candidate" ;; esac\n  done\n  case "$context" in\n${cases}\n  esac\n  prev="\${COMP_WORDS[COMP_CWORD-1]}"\n  case "$context|$prev" in\n${valueCases}\n  esac\n  COMPREPLY=( $(compgen -W "$candidates" -- "\${COMP_WORDS[COMP_CWORD]}") )\n}\ncomplete -F _mandala_complete mandala\n`;
  return `#compdef mandala\n_mandala() {\n  local context='' word candidate candidates='' prev='' i\n  for ((i=2; i<CURRENT; i++)); do\n    word="$words[i]"\n    candidate="\${context:+$context }$word"\n    case "$candidate" in ${transitions}) context="$candidate" ;; esac\n  done\n  case "$context" in\n${cases}\n  esac\n  prev="$words[CURRENT-1]"\n  case "$context|$prev" in\n${valueCases}\n  esac\n  compadd -- \${=candidates}\n}\ncompdef _mandala mandala\n`;
}

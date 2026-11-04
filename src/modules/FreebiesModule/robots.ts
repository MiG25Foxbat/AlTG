/** Минимальный разбор robots.txt: группа нашего агента (иначе `*`), Allow/Disallow по самому длинному совпадению, Crawl-delay. */

export interface Robots {
  allows(pathAndQuery: string): boolean;
  /** Секунды между запросами, если указано */
  crawlDelay: number | null;
}

export const ALLOW_ALL: Robots = { allows: () => true, crawlDelay: null };

function patternToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body.replace(/\\\$$/, '$'));
}

export function parseRobots(text: string, agent: string): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ''));
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [], delay: null }));
      current.agents.push(m[2].toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((field === 'allow' || field === 'disallow') && m[2]) current.rules.push({ allow: field === 'allow', pattern: m[2] });
    else if (field === 'crawl-delay' && Number.isFinite(Number(m[2]))) current.delay = Number(m[2]);
  }
  const name = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && name.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  if (!group) return ALLOW_ALL;
  const rules = group.rules.map((r) => ({ allow: r.allow, re: patternToRegExp(r.pattern), len: r.pattern.length }));
  return {
    crawlDelay: group.delay,
    allows(path) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

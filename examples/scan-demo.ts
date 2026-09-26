/**
 * Lints two small, deliberately realistic stylesheets and prints the real
 * findings: one with the mistakes this tool exists for, one without any.
 *
 *   node examples/scan-demo.ts
 */
import { lint } from '../src/index.ts';

const broken = `
/* Renamed the wrapper's theme class but forgot this rule reads the old
   variable name from the wrong place entirely. */
.dark-theme {
  --surface: #1c1c1e;
  --on-surface: #f5f5f5;
}

.card {
  background: var(--surface);
  color: var(--on-surface, black);
}

/* Registered as a length; someone pasted a color into it by mistake. */
@property --card-radius {
  syntax: "<length>";
  inherits: false;
  initial-value: 4px;
}

.card {
  --card-radius: crimson;
  border-radius: var(--card-radius);
}

/* Declared for a component that got deleted; nothing reads this anymore. */
:root {
  --legacy-banner-height: 64px;
}
`;

const clean = `
.dark-theme {
  --surface: #1c1c1e;
  --on-surface: #f5f5f5;

  .card {
    background: var(--surface);
    color: var(--on-surface, black);
  }
}

@property --card-radius {
  syntax: "<length>";
  inherits: false;
  initial-value: 4px;
}

.card {
  --card-radius: 4px;
  border-radius: var(--card-radius);
}
`;

function report(label: string, findings: ReturnType<typeof lint>): void {
  console.log(`\n${label}`);
  if (findings.length === 0) {
    console.log('  no findings');
    return;
  }
  for (const f of findings) {
    const tag = f.confidence === 'possible' ? `${f.severity}?` : f.severity;
    console.log(`  ${f.line}:${f.column}  ${tag}  [${f.rule}]  ${f.message}`);
  }
}

report(
  'broken.css, default run (three provable mistakes)',
  lint([{ file: 'broken.css', source: broken }]),
);

report(
  'broken.css, --include-possible (adds the scope mismatch itself: --surface and\n' +
    '--on-surface are declared only under .dark-theme, and .card is a flat, unrelated\n' +
    "selector — nothing in the CSS proves .card is ever inside .dark-theme, so this\n" +
    'is reported as possible, not certain)',
  lint([{ file: 'broken.css', source: broken }], { includePossible: true }),
);

report('clean.css, the same theme fixed', lint([{ file: 'clean.css', source: clean }]));

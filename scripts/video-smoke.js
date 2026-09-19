'use strict';

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const {
  renderLesson,
  ensureVideoEnvironment
} = require('../video');

const lesson = {
  title: 'משוואות ריבועיות — בדיקת מנוע',
  duration: 27,
  scenes: [
    {
      seconds: 2.6,
      background: {
        color: 'black',
        pattern: 'grid'
      },
      elements: [
        {
          type: 'title',
          text: 'שני שורשים. דרך אחת ברורה.'
        },
        {
          type: 'formula',
          text: 'x^2-5x+6=0'
        }
      ]
    },
    {
      seconds: 7.5,
      background: {
        color: 'white',
        pattern: 'none'
      },
      elements: [
        {
          type: 'title',
          text: 'מפרקים לגורמים'
        },
        {
          type: 'equation-sequence',
          steps: [
            {
              formula: 'x^2-5x+6=0',
              note: 'מחפשים שני מספרים שמכפלתם 6 וסכומם ‎-5'
            },
            {
              formula: '(x-2)(x-3)=0',
              note: 'המספרים הם 2 ו-3'
            },
            {
              formula: 'x=2,\\;x=3',
              note: 'כל גורם יכול להיות אפס'
            }
          ]
        }
      ]
    },
    {
      seconds: 6.5,
      background: {
        color: 'black',
        pattern: 'dots'
      },
      elements: [
        {
          type: 'title',
          text: 'רואים את זה בגרף'
        },
        {
          type: 'graph',
          equation: 'x^2-5*x+6'
        },
        {
          type: 'text',
          text: 'הגרף חוצה את ציר x בדיוק ב־2 וב־3.'
        }
      ]
    },
    {
      seconds: 5,
      background: {
        color: 'white',
        pattern: 'none'
      },
      elements: [
        {
          type: 'title',
          text: 'בודקים פתרון'
        },
        {
          type: 'formula',
          text: '2^2-5\\cdot2+6=0'
        },
        {
          type: 'badge',
          text: '✓ נכון'
        }
      ]
    },
    {
      seconds: 5.4,
      background: {
        color: 'black',
        pattern: 'none'
      },
      elements: [
        {
          type: 'title',
          text: 'סיכום'
        },
        {
          type: 'summary',
          items: [
            {
              label: 'פירוק',
              value: '(x-2)(x-3)'
            },
            {
              label: 'פתרונות',
              value: 'x=2,\\;x=3'
            }
          ]
        }
      ]
    }
  ]
};

async function main() {
  console.log('Checking Sifra video environment...');

  const environment =
    await ensureVideoEnvironment();

  if (!environment.ok) {
    console.error(
      JSON.stringify(
        environment,
        null,
        2
      )
    );

    process.exitCode = 1;
    return;
  }

  console.log('Environment OK. Rendering smoke test...');

  const result =
    await renderLesson({
      lesson,
      jobId:
        'smoke-' +
        Date.now(),
      onProgress(progress, message) {
        process.stdout.write(
          '\r' +
          String(
            Math.round(
              progress * 100
            )
          ).padStart(3, ' ') +
          '%  ' +
          String(message || '')
            .padEnd(42, ' ')
        );
      }
    });

  process.stdout.write('\n');

  const destination =
    path.join(
      process.cwd(),
      'sifra-video-smoke.mp4'
    );

  const posterDestination =
    path.join(
      process.cwd(),
      'sifra-video-smoke.jpg'
    );

  await Promise.all([
    fs.copyFile(
      result.outputPath,
      destination
    ),
    fs.copyFile(
      result.posterPath,
      posterDestination
    )
  ]);

  console.log(
    'Rendered:',
    destination
  );

  console.log(
    'Poster:',
    posterDestination
  );

  console.log(
    'Metadata:',
    result.probe
  );

  console.log(
    'Quality:',
    result.quality
  );
}

main().catch((error) => {
  console.error(
    '\nSifra video smoke test failed:',
    error
  );

  process.exitCode = 1;
});

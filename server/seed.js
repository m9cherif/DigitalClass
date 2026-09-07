/**
 * Seeds a demo school: users of every role, four CS courses, lessons, and
 * quizzes exercising all 20 question types in French, English and Arabic.
 * Run with `npm run seed` (or `npm run reset` to wipe first).
 */
import 'dotenv/config';
import { db, flushAll, initStore, COLLECTIONS, storeInfo } from './lib/db.js';
import { hashPassword } from './middleware/auth.js';

const backend = await initStore();
const force = process.argv.includes('--force');

if (db.users.count() && !force) {
  console.log(`Data already present in the ${backend} store. Use \`npm run reset\` to wipe and reseed.`);
  process.exit(0);
}
if (force) for (const c of COLLECTIONS) db[c]?.clear();

const user = (name, email, role, extra = {}) => db.users.insert({
  name, email, role, password: hashPassword('password123'),
  status: 'active', lang: extra.lang || 'fr', theme: 'dark',
  xp: 0, level: 1, streak: 0, longestStreak: 0, childIds: [], bio: '', avatar: null, ...extra
});

const admin = user('Amine Directeur', 'admin@digitalclass.dev', 'admin');
const tNadia = user('Nadia Benali', 'nadia@digitalclass.dev', 'teacher', { bio: 'Algorithmique et structures de données.' });
const tOmar = user('Omar Haddad', 'omar@digitalclass.dev', 'teacher', { lang: 'ar', bio: 'شبكات وأمن المعلومات.' });
const tSarah = user('Sarah Klein', 'sarah@digitalclass.dev', 'teacher', { lang: 'en', bio: 'Databases and the web.' });

const students = [
  ['Yasmine Toumi', 'yasmine@digitalclass.dev', 'fr'],
  ['Karim Belhadj', 'karim@digitalclass.dev', 'ar'],
  ['Lina Meddeb', 'lina@digitalclass.dev', 'fr'],
  ['Tom Fischer', 'tom@digitalclass.dev', 'en'],
  ['Sofia Rossi', 'sofia@digitalclass.dev', 'en'],
  ['Mehdi Aouini', 'mehdi@digitalclass.dev', 'ar']
].map(([n, e, l]) => user(n, e, 'student', { lang: l, xp: Math.floor(Math.random() * 400) }));

/* ------------------------------------------------------------------ courses */

const course = (teacher, o) => db.courses.insert({
  teacherId: teacher.id, coTeacherIds: [], status: 'published',
  tags: o.tags || [], langs: o.langs || ['fr', 'en', 'ar'], ...o
});

const cAlgo = course(tNadia, {
  title: 'Algorithmique et programmation',
  description: "Variables, conditions, boucles, fonctions, complexité et structures de données de base.",
  topic: 'algorithms', level: 'beginner', lang: 'fr', color: '#6366f1', estimatedHours: 24,
  tags: ['python', 'algorithmes', 'débutant'],
  i18n: {
    en: { title: 'Algorithms and Programming', description: 'Variables, conditionals, loops, functions, complexity and core data structures.' },
    ar: { title: 'الخوارزميات والبرمجة', description: 'المتغيرات والشروط والحلقات والدوال والتعقيد وهياكل البيانات الأساسية.' }
  }
});

const cWeb = course(tSarah, {
  title: 'Web Development Foundations',
  description: 'HTML, CSS, JavaScript, the DOM, HTTP and how a browser actually renders a page.',
  topic: 'web', level: 'beginner', lang: 'en', color: '#0ea5e9', estimatedHours: 30,
  tags: ['html', 'css', 'javascript'],
  i18n: {
    fr: { title: 'Fondamentaux du développement web', description: 'HTML, CSS, JavaScript, le DOM, HTTP et le rendu du navigateur.' },
    ar: { title: 'أساسيات تطوير الويب', description: 'HTML و CSS و JavaScript و DOM و HTTP وكيفية عرض المتصفح للصفحة.' }
  }
});

const cNet = course(tOmar, {
  title: 'الشبكات وأمن المعلومات',
  description: 'نموذج OSI، TCP/IP، العناوين، التوجيه، التشفير وأساسيات الأمن السيبراني.',
  topic: 'networks', level: 'intermediate', lang: 'ar', color: '#10b981', estimatedHours: 26,
  tags: ['شبكات', 'أمن', 'tcp/ip'],
  i18n: {
    fr: { title: 'Réseaux et sécurité informatique', description: 'Modèle OSI, TCP/IP, adressage, routage, chiffrement et bases de la cybersécurité.' },
    en: { title: 'Networks and Information Security', description: 'OSI model, TCP/IP, addressing, routing, encryption and cybersecurity basics.' }
  }
});

const cData = course(tSarah, {
  title: 'Bases de données et SQL',
  description: 'Modèle relationnel, clés, jointures, normalisation et requêtes SQL.',
  topic: 'databases', level: 'intermediate', lang: 'fr', color: '#f59e0b', estimatedHours: 20,
  tags: ['sql', 'mysql', 'modélisation'],
  i18n: {
    en: { title: 'Databases and SQL', description: 'Relational model, keys, joins, normalisation and SQL queries.' },
    ar: { title: 'قواعد البيانات و SQL', description: 'النموذج العلائقي والمفاتيح والوصلات والتطبيع واستعلامات SQL.' }
  }
});

const lesson = (c, order, title, body, extra = {}) =>
  db.lessons.insert({ courseId: c.id, order, title, body, durationMin: 15, attachments: [], i18n: {}, preview: order === 1, ...extra });

lesson(cAlgo, 1, 'Qu\'est-ce qu\'un algorithme ?', `# Qu'est-ce qu'un algorithme ?

Un **algorithme** est une suite finie d'instructions non ambiguës qui, appliquée à des données en entrée, produit un résultat en sortie.

## Les trois structures fondamentales

1. **La séquence** — les instructions s'exécutent l'une après l'autre.
2. **La sélection** — \`si condition alors ... sinon ...\`
3. **La répétition** — \`tant que\`, \`pour\`.

\`\`\`python
def maximum(liste):
    plus_grand = liste[0]
    for valeur in liste[1:]:
        if valeur > plus_grand:
            plus_grand = valeur
    return plus_grand
\`\`\`

Cet algorithme parcourt la liste **une seule fois** : sa complexité est en O(n).`);

lesson(cAlgo, 2, 'Complexité algorithmique', `# Complexité algorithmique

La notation **grand O** décrit comment le temps d'exécution grandit avec la taille \`n\` des données.

| Complexité | Nom | Exemple |
|---|---|---|
| O(1) | constante | accès à un tableau |
| O(log n) | logarithmique | recherche dichotomique |
| O(n) | linéaire | parcours de liste |
| O(n log n) | quasi-linéaire | tri fusion |
| O(n²) | quadratique | tri à bulles |

Doubler \`n\` multiplie par **4** le temps d'un algorithme en O(n²).`);

lesson(cAlgo, 3, 'Structures de données', `# Structures de données

- **Tableau** — accès direct par index, O(1).
- **Liste chaînée** — insertion en tête O(1), accès O(n).
- **Pile (LIFO)** — \`push\` / \`pop\`, utilisée pour les appels de fonctions.
- **File (FIFO)** — \`enfiler\` / \`défiler\`, utilisée pour les parcours en largeur.
- **Table de hachage** — accès moyen en O(1) par clé.`);

lesson(cWeb, 1, 'How the web works', `# How the web works

Typing a URL sets off a well-defined chain of events:

1. **DNS lookup** turns \`example.com\` into an IP address.
2. **TCP handshake**, then **TLS handshake** for HTTPS.
3. The browser sends an **HTTP request**; the server returns a **response**.
4. The HTML is parsed into the **DOM**, CSS into the **CSSOM**, and the two combine into the render tree.

\`\`\`http
GET /index.html HTTP/1.1
Host: example.com
Accept: text/html
\`\`\``);

lesson(cWeb, 2, 'The DOM and events', `# The DOM and events

The DOM is a live tree of objects representing your document.

\`\`\`js
document.querySelector('#btn')
  .addEventListener('click', (event) => {
    event.preventDefault();
    document.body.classList.toggle('dark');
  });
\`\`\`

Events **capture** down the tree, hit the target, then **bubble** back up.`);

lesson(cNet, 1, 'نموذج OSI', `# نموذج OSI

يقسم نموذج OSI الاتصال الشبكي إلى **سبع طبقات**:

1. الطبقة الفيزيائية — الإشارات والكابلات
2. طبقة ربط البيانات — عناوين MAC والإطارات
3. طبقة الشبكة — عناوين IP والتوجيه
4. طبقة النقل — TCP و UDP
5. طبقة الجلسة
6. طبقة العرض — التشفير والضغط
7. طبقة التطبيق — HTTP و DNS و SMTP

كل طبقة تخدم الطبقة التي فوقها وتعتمد على التي تحتها.`);

lesson(cData, 1, 'Le modèle relationnel', `# Le modèle relationnel

Une **table** est un ensemble de lignes partageant les mêmes colonnes.

- **Clé primaire** — identifie une ligne de façon unique.
- **Clé étrangère** — référence la clé primaire d'une autre table.
- **Jointure** — recombine les lignes de deux tables selon une condition.

\`\`\`sql
SELECT e.nom, c.titre
FROM etudiants e
JOIN inscriptions i ON i.etudiant_id = e.id
JOIN cours c        ON c.id = i.cours_id
WHERE c.niveau = 'debutant';
\`\`\``);

/* ------------------------------------------------------------------ quizzes */

function quiz(c, o, questions) {
  const q = db.quizzes.insert({
    courseId: c.id, authorId: c.teacherId, title: o.title, description: o.description || '',
    kind: o.kind || 'practice', difficulty: o.difficulty || 'medium',
    timeLimitSec: o.timeLimitSec ?? 0, maxAttempts: o.maxAttempts ?? 0,
    shuffleQuestions: o.shuffleQuestions !== false, showAnswersAfter: true,
    passPercent: o.passPercent ?? 60, published: true, questionIds: [], i18n: o.i18n || {}
  });
  const ids = questions.map(x => db.questions.insert({
    quizId: q.id, courseId: c.id, authorId: c.teacherId,
    points: x.points ?? 1, difficulty: x.difficulty || o.difficulty || 'medium',
    explanation: x.explanation || '', hint: x.hint || null, tags: x.tags || [], i18n: x.i18n || {}, ...x
  }).id);
  db.quizzes.update(q.id, { questionIds: ids });
  return q;
}

// Every one of the 20 question types appears at least once below.
quiz(cAlgo, {
  title: 'Les bases de l\'algorithmique',
  description: 'Quiz de révision couvrant tous les types de questions.',
  kind: 'graded', difficulty: 'easy', timeLimitSec: 900, passPercent: 60,
  i18n: { en: { title: 'Algorithm fundamentals' }, ar: { title: 'أساسيات الخوارزميات' } }
}, [
  {
    type: 'mcq_single', prompt: 'Quelle est la complexité de la recherche dichotomique ?',
    i18n: { en: { prompt: 'What is the complexity of binary search?' }, ar: { prompt: 'ما هو تعقيد البحث الثنائي؟' } },
    data: { options: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], answer: 1 },
    explanation: 'À chaque étape on divise l\'espace de recherche par deux.', points: 2
  },
  {
    type: 'mcq_multiple', prompt: 'Lesquelles de ces structures sont linéaires ?',
    i18n: { en: { prompt: 'Which of these structures are linear?' } },
    data: { options: ['Pile', 'Arbre binaire', 'File', 'Graphe', 'Liste chaînée'], answer: [0, 2, 4], partial: true },
    explanation: 'Pile, file et liste chaînée organisent les éléments en séquence.', points: 3
  },
  {
    type: 'true_false', prompt: 'Un algorithme en O(n²) est toujours plus lent qu\'un algorithme en O(n log n).',
    data: { answer: false },
    explanation: 'Pour de petites valeurs de n, les constantes cachées peuvent inverser le classement.', points: 1
  },
  {
    type: 'short_answer', prompt: 'Comment appelle-t-on une fonction qui s\'appelle elle-même ?',
    i18n: { en: { prompt: 'What do you call a function that calls itself?' } },
    data: { accepted: ['récursive', 'recursive', 'fonction récursive', 'récursivité'] }, points: 2
  },
  {
    type: 'numeric', prompt: 'Combien de comparaisons au maximum pour trouver un élément parmi 1024 avec une recherche dichotomique ?',
    data: { answer: 10, tolerance: 0 },
    explanation: 'log₂(1024) = 10.', points: 2
  },
  {
    type: 'fill_blanks', prompt: 'Complétez la boucle Python.',
    data: {
      text: 'for i in {{1}}(10):\n    if i {{2}} 2 == 0:\n        print(i)',
      blanks: [{ accepted: ['range'], hint: 'fonction de séquence' }, { accepted: ['%'], hint: 'opérateur' }]
    }, points: 2
  },
  {
    type: 'ordering', prompt: 'Classez ces complexités de la plus rapide à la plus lente.',
    data: { items: ['O(n²)', 'O(1)', 'O(n log n)', 'O(log n)', 'O(n)'], answer: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n²)'] },
    points: 3
  },
  {
    type: 'matching', prompt: 'Associez chaque structure à son principe.',
    data: {
      left: ['Pile', 'File', 'Table de hachage'],
      right: ['LIFO', 'FIFO', 'Clé → valeur'],
      answer: { Pile: 'LIFO', File: 'FIFO', 'Table de hachage': 'Clé → valeur' }
    }, points: 3
  },
  {
    type: 'categorize', prompt: 'Rangez chaque tri dans la bonne catégorie de complexité moyenne.',
    data: {
      items: ['Tri à bulles', 'Tri fusion', 'Tri par insertion', 'Tri rapide'],
      buckets: ['O(n²)', 'O(n log n)'],
      answer: { 'Tri à bulles': 'O(n²)', 'Tri fusion': 'O(n log n)', 'Tri par insertion': 'O(n²)', 'Tri rapide': 'O(n log n)' }
    }, points: 4
  },
  {
    type: 'code_output', prompt: 'Qu\'affiche ce programme ?',
    data: {
      language: 'python',
      code: 'total = 0\nfor i in range(1, 5):\n    total += i\nprint(total)',
      accepted: ['10']
    }, points: 2
  },
  {
    type: 'code_write', prompt: 'Écrivez une fonction `factorielle(n)` qui renvoie n!.',
    i18n: { en: { prompt: 'Write a function `factorielle(n)` returning n!.' } },
    data: {
      language: 'javascript',
      starter: 'function factorielle(n) {\n  // votre code ici\n}',
      functionName: 'factorielle',
      tests: [
        { name: '0! = 1', args: [0], expected: 1 },
        { name: '5! = 120', args: [5], expected: 120 },
        { name: '10!', args: [10], expected: 3628800, hidden: true }
      ]
    }, points: 5
  },
  {
    type: 'code_fix', prompt: 'Ce code doit renvoyer la somme du tableau. Corrigez-le.',
    data: {
      language: 'javascript',
      code: 'function somme(t) {\n  let s = 0;\n  for (let i = 1; i <= t.length; i++) s += t[i];\n  return s;\n}',
      starter: 'function somme(t) {\n  let s = 0;\n  for (let i = 1; i <= t.length; i++) s += t[i];\n  return s;\n}',
      functionName: 'somme',
      tests: [
        { name: '[1,2,3]', args: [[1, 2, 3]], expected: 6 },
        { name: 'vide', args: [[]], expected: 0 }
      ]
    },
    explanation: 'L\'indice doit partir de 0 et s\'arrêter avant t.length.', points: 4
  },
  {
    type: 'bug_find', prompt: 'Quelle ligne contient le bug ?',
    data: {
      language: 'python',
      code: '1  def moyenne(notes):\n2      total = 0\n3      for n in notes:\n4          total = n\n5      return total / len(notes)',
      answer: 4
    },
    explanation: 'Ligne 4 : il faut `total += n`, sinon on écrase l\'accumulateur.', points: 3
  },
  {
    type: 'essay', prompt: 'Expliquez avec vos mots la différence entre une pile et une file, avec un exemple d\'usage pour chacune.',
    data: { minWords: 60, rubric: ['Définition LIFO/FIFO', 'Un exemple concret par structure', 'Clarté de la rédaction'] },
    points: 6
  }
]);

/* Self-contained SVG diagrams, so the demo needs no uploaded assets. */
// width/height as well as viewBox: an SVG with only a viewBox has no intrinsic
// size, and would collapse to nothing wherever the CSS does not force one.
const svg = body =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260">${body}</svg>`);

const boardSvg = svg(`
  <rect width="400" height="260" fill="#0f172a"/>
  <rect x="40" y="40" width="90" height="70" rx="8" fill="#6366f1"/>
  <text x="85" y="82" fill="#fff" font-size="16" font-family="sans-serif" text-anchor="middle">CPU</text>
  <rect x="180" y="40" width="170" height="34" rx="6" fill="#22d3ee"/>
  <text x="265" y="63" fill="#062b33" font-size="14" font-family="sans-serif" text-anchor="middle">RAM</text>
  <rect x="180" y="96" width="170" height="34" rx="6" fill="#22d3ee"/>
  <rect x="40" y="160" width="140" height="60" rx="8" fill="#f59e0b"/>
  <text x="110" y="196" fill="#3b2600" font-size="14" font-family="sans-serif" text-anchor="middle">Disque</text>
  <rect x="220" y="160" width="130" height="60" rx="8" fill="#34d399"/>
  <text x="285" y="196" fill="#05261a" font-size="13" font-family="sans-serif" text-anchor="middle">Carte réseau</text>`);

const shape = (fill, label) => svg(
  `<rect width="400" height="260" fill="#111827"/>
   <rect x="60" y="40" width="280" height="180" rx="14" fill="${fill}"/>
   <text x="200" y="145" fill="#0b0f1a" font-size="34" font-family="sans-serif" text-anchor="middle">${label}</text>`);

quiz(cAlgo, {
  title: 'Lire un schéma — questions illustrées',
  description: 'Types visuels : cliquer sur une image, annoter un schéma, ordonner et choisir des images.',
  kind: 'practice', difficulty: 'easy',
  i18n: { en: { title: 'Reading a diagram — visual questions' }, ar: { title: 'قراءة رسم بياني — أسئلة مصورة' } }
}, [
  {
    type: 'image_hotspot',
    prompt: 'Cliquez sur le processeur (CPU) dans ce schéma.',
    i18n: { en: { prompt: 'Click the processor (CPU) in this diagram.' },
            ar: { prompt: 'انقر على المعالج (CPU) في هذا الرسم.' } },
    data: {
      image: boardSvg,
      imageAlt: 'Schéma simplifié d\'une carte mère',
      zones: [
        { id: 'cpu', label: 'CPU', x: 10, y: 15, w: 23, h: 27 },
        { id: 'ram', label: 'RAM', x: 45, y: 15, w: 43, h: 13 },
        { id: 'disk', label: 'Disque', x: 10, y: 61, w: 35, h: 23 },
        { id: 'nic', label: 'Réseau', x: 55, y: 61, w: 33, h: 23 }
      ],
      answer: ['cpu']
    },
    explanation: 'Le CPU exécute les instructions ; la RAM ne fait que les stocker temporairement.',
    points: 3
  },
  {
    type: 'image_label',
    prompt: 'Annotez chaque composant du schéma.',
    i18n: { en: { prompt: 'Label each component of the diagram.' } },
    data: {
      image: boardSvg,
      markers: [{ id: 'm1', x: 21, y: 29 }, { id: 'm2', x: 66, y: 22 }, { id: 'm3', x: 27, y: 73 }],
      labels: ['CPU', 'RAM', 'Disque dur', 'Carte réseau'],
      answer: { m1: 'CPU', m2: 'RAM', m3: 'Disque dur' }
    },
    points: 3
  },
  {
    type: 'image_choice',
    prompt: 'Quelle couleur représente la mémoire vive dans le schéma précédent ?',
    i18n: { en: { prompt: 'Which colour stands for RAM in the diagram above?' } },
    data: {
      options: [
        { url: shape('#6366f1', 'A'), label: 'Violet' },
        { url: shape('#22d3ee', 'B'), label: 'Cyan' },
        { url: shape('#f59e0b', 'C'), label: 'Orange' }
      ],
      answer: 1
    },
    points: 2
  },
  {
    type: 'image_order',
    prompt: 'Remettez les étapes du démarrage dans l\'ordre.',
    i18n: { en: { prompt: 'Put the boot steps back in order.' } },
    data: {
      items: [
        { id: 's1', url: shape('#6366f1', '1'), caption: 'Mise sous tension' },
        { id: 's2', url: shape('#22d3ee', '2'), caption: 'Le BIOS teste le matériel' },
        { id: 's3', url: shape('#f59e0b', '3'), caption: 'Chargement du système' },
        { id: 's4', url: shape('#34d399', '4'), caption: 'Session ouverte' }
      ],
      answer: ['s1', 's2', 's3', 's4']
    },
    points: 4
  },
  {
    type: 'mcq_single',
    prompt: 'D\'après le schéma, combien de barrettes de RAM sont représentées ?',
    media: { url: boardSvg, alt: 'Schéma d\'une carte mère', kind: 'image' },
    data: { options: ['1', '2', '3', '4'], answer: 1 },
    explanation: 'Une question classique peut aussi porter une illustration.',
    points: 2
  }
]);

quiz(cAlgo, {
  title: 'Cartes de révision — vocabulaire',
  kind: 'flashcards', difficulty: 'easy'
}, [
  { type: 'flashcard', prompt: 'Récursivité', data: { back: 'Fonction qui s\'appelle elle-même, avec un cas de base qui arrête la descente.' } },
  { type: 'flashcard', prompt: 'Invariant de boucle', data: { back: 'Propriété vraie avant, pendant et après chaque itération.' } },
  { type: 'flashcard', prompt: 'Mémoïsation', data: { back: 'Mise en cache des résultats d\'appels déjà calculés.' } },
  { type: 'flashcard', prompt: 'Complexité amortie', data: { back: 'Coût moyen par opération sur une longue séquence d\'opérations.' } }
]);

quiz(cWeb, {
  title: 'HTML, CSS and the DOM',
  kind: 'graded', difficulty: 'medium', timeLimitSec: 600,
  i18n: { fr: { title: 'HTML, CSS et le DOM' }, ar: { title: 'HTML و CSS و DOM' } }
}, [
  {
    type: 'mcq_single', prompt: 'Which HTTP status code means "Not Found"?',
    data: { options: ['200', '301', '404', '500'], answer: 2 }, points: 1
  },
  {
    type: 'hotspot', prompt: 'Click the part of the URL that is the query string.',
    data: {
      image: null,
      regions: [
        { id: 'scheme', label: 'https://' }, { id: 'host', label: 'example.com' },
        { id: 'path', label: '/search' }, { id: 'query', label: '?q=dom&lang=fr' }
      ],
      answer: ['query']
    }, points: 2
  },
  {
    type: 'code_output', prompt: 'What does this log?',
    data: { language: 'javascript', code: 'console.log(typeof null, [] + {});', accepted: ['object [object Object]'] },
    points: 2
  },
  {
    type: 'terminal', prompt: 'Which command starts a git repository in the current folder?',
    data: { accepted: ['git init'], ignoreFlags: true }, points: 1
  },
  {
    type: 'short_answer', prompt: 'Which CSS property makes an element a flex container? (property: value)',
    data: { accepted: ['display: flex', 'display:flex'], typoTolerance: 0.9 }, points: 2
  },
  {
    type: 'ordering', prompt: 'Order the steps a browser takes to display a page.',
    data: {
      items: ['Paint', 'DNS lookup', 'Parse HTML into DOM', 'Layout', 'HTTP request'],
      answer: ['DNS lookup', 'HTTP request', 'Parse HTML into DOM', 'Layout', 'Paint']
    }, points: 3
  }
]);

quiz(cNet, {
  title: 'الشبكات: الأساسيات',
  kind: 'graded', difficulty: 'medium', timeLimitSec: 720,
  i18n: { fr: { title: 'Réseaux : les bases' }, en: { title: 'Networking basics' } }
}, [
  {
    type: 'mcq_single', prompt: 'في أي طبقة من نموذج OSI يعمل بروتوكول TCP؟',
    i18n: { fr: { prompt: 'À quelle couche du modèle OSI fonctionne TCP ?' }, en: { prompt: 'At which OSI layer does TCP operate?' } },
    data: { options: ['الطبقة 2', 'الطبقة 3', 'الطبقة 4', 'الطبقة 7'], answer: 2 }, points: 2
  },
  {
    type: 'base_convert', prompt: 'حوّل العنوان 192 إلى النظام الثنائي.',
    i18n: { fr: { prompt: 'Convertissez 192 en binaire.' }, en: { prompt: 'Convert 192 to binary.' } },
    data: { value: '192', fromBase: 10, toBase: 2 }, points: 2
  },
  {
    type: 'base_convert', prompt: 'حوّل 0xFF إلى النظام العشري.',
    data: { value: 'FF', fromBase: 16, toBase: 10 }, points: 2
  },
  {
    type: 'truth_table', prompt: 'أكمل جدول الحقيقة للعملية A AND B.',
    i18n: { fr: { prompt: 'Complétez la table de vérité de A ET B.' } },
    data: { inputs: ['A', 'B'], expression: 'A AND B', answer: [false, false, false, true] }, points: 3
  },
  {
    type: 'numeric', prompt: 'كم عدد العناوين المتاحة في شبكة /24؟',
    i18n: { fr: { prompt: "Combien d'adresses dans un réseau /24 ?" } },
    data: { answer: 256, tolerance: 0 },
    explanation: '2^(32-24) = 256 عنوانًا (254 قابلة للاستخدام).', points: 2
  },
  {
    type: 'terminal', prompt: 'ما الأمر الذي يختبر الوصول إلى مضيف؟',
    data: { accepted: ['ping', 'ping example.com'], ignoreFlags: true }, points: 1
  },
  {
    type: 'matching', prompt: 'اربط كل بروتوكول بمنفذه الافتراضي.',
    data: {
      left: ['HTTP', 'HTTPS', 'SSH', 'DNS'], right: ['80', '443', '22', '53'],
      answer: { HTTP: '80', HTTPS: '443', SSH: '22', DNS: '53' }
    }, points: 4
  }
]);

quiz(cData, {
  title: 'SQL : interroger une base',
  kind: 'graded', difficulty: 'medium', timeLimitSec: 900,
  i18n: { en: { title: 'SQL: querying a database' } }
}, [
  {
    type: 'sql_query', prompt: 'Sélectionnez toutes les colonnes de la table `etudiants`.',
    data: { schema: 'etudiants(id, nom, age, ville)', accepted: ['SELECT * FROM etudiants;'] }, points: 2
  },
  {
    type: 'sql_query', prompt: 'Sélectionnez le nom des étudiants de plus de 18 ans.',
    data: { schema: 'etudiants(id, nom, age, ville)', accepted: ['SELECT nom FROM etudiants WHERE age > 18;'] }, points: 3
  },
  {
    type: 'mcq_single', prompt: 'Quelle jointure conserve toutes les lignes de la table de gauche ?',
    data: { options: ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'CROSS JOIN'], answer: 1 }, points: 2
  },
  {
    type: 'fill_blanks', prompt: 'Complétez la requête d\'agrégation.',
    data: {
      text: 'SELECT ville, {{1}}(*) FROM etudiants {{2}} BY ville;',
      blanks: [{ accepted: ['COUNT', 'count'] }, { accepted: ['GROUP', 'group'] }]
    }, points: 3
  },
  {
    type: 'categorize', prompt: 'Classez chaque commande SQL.',
    data: {
      items: ['SELECT', 'CREATE TABLE', 'INSERT', 'DROP TABLE'], buckets: ['DDL', 'DML'],
      answer: { SELECT: 'DML', 'CREATE TABLE': 'DDL', INSERT: 'DML', 'DROP TABLE': 'DDL' }
    }, points: 4
  }
]);

/* -------------------------------------------------- enrollments & activity */

for (const s of students) {
  for (const c of [cAlgo, cWeb, cNet, cData].slice(0, 2 + Math.floor(Math.random() * 3))) {
    db.enrollments.insert({ userId: s.id, courseId: c.id, status: 'active', progress: {}, completed: false });
  }
}

db.announcements.insert({
  authorId: tNadia.id, courseId: cAlgo.id, pinned: true,
  title: 'Contrôle continu vendredi',
  body: 'Le quiz noté « Les bases de l\'algorithmique » compte pour 20% de la moyenne. Révisez les complexités.'
});
db.announcements.insert({
  authorId: admin.id, courseId: null, pinned: false,
  title: 'Bienvenue sur DigitalClass',
  body: 'Plateforme disponible en français, anglais et arabe. Lancez une party de quiz depuis n\'importe quel cours.'
});

const thread = db.threads.insert({
  title: 'Pourquoi le tri rapide est-il en O(n²) dans le pire cas ?',
  body: 'Je croyais que quicksort était O(n log n). Quelqu\'un peut expliquer le pire cas ?',
  courseId: cAlgo.id, authorId: students[0].id, tags: ['tri', 'complexité'],
  pinned: false, locked: false, solved: true, views: 42, votes: 0, voters: {},
  lastReplyAt: new Date().toISOString()
});
db.posts.insert({
  threadId: thread.id, authorId: tNadia.id, accepted: true, votes: 3, voters: {},
  body: 'Le pire cas arrive quand le pivot est systématiquement le plus petit ou le plus grand élément : les partitions sont de taille 0 et n-1, on obtient n niveaux de récursion à n comparaisons, donc O(n²). Un pivot aléatoire ou médian-de-trois rend ce cas très improbable.'
});

await flushAll();

console.log(`
  DigitalClass seeded into the ${backend} store (${storeInfo().failures} write failures).

  Accounts (password for all: password123)
    admin    admin@digitalclass.dev
    teacher  nadia@digitalclass.dev     (FR — algorithmique)
    teacher  omar@digitalclass.dev      (AR — réseaux)
    teacher  sarah@digitalclass.dev     (EN — web & SQL)
    student  yasmine@digitalclass.dev   (+ 5 more students)

  ${db.courses.count()} courses · ${db.lessons.count()} lessons · ${db.quizzes.count()} quizzes · ${db.questions.count()} questions
`);

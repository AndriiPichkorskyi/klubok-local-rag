/**
 * Файл: src/tests/test-cases.js
 * Опис: Набір кейсів RAG-бенчмарку.
 *
 * Поле `language` задане ЯВНО і вручну перевірене. Три значення:
 *   "uk"      — запит українською;
 *   "en"      — запит англійською;
 *   "neutral" — запит поза мовою: назва бренду ("Photoshop"), навмисне
 *               безглуздя ("asdfasdf qwerty", "івапівпавіп"), символьний або
 *               форматний токен. Такі кейси не потрапляють ні в українську,
 *               ні в англійську метрику — інакше вони псували б обидві.
 *
 * Автовизначення тут НЕ використовується: франк (franc-min) на цих самих
 * рядках дає "Photoshop" → eng, "asdfasdf qwerty" → eng, "івапівпавіп" → ukr,
 * тобто помиляється рівно там, де правильна відповідь "neutral".
 *
 * ВАЖЛИВО для інтерпретації звітів: у цьому наборі НЕМАЄ жодного англійського
 * кейса (23 uk + 3 neutral). Крослінгвальний експеримент живе в зовнішніх
 * датасетах (`dataset_intents/ood/ambiguous.json`), де поділ майже рівний.
 */
export const TEST_CASES = [
  // 1. Валідні запити (чіткі задачі)
  {
    query: "Як створити електронну таблицю?",
    expectedApp: "Numbers",
    type: "valid",
    language: "uk",
  },
  {
    query: "як обрізати відео",
    expectedApp: "iMovie",
    type: "valid",
    language: "uk",
  },
  {
    query: "як слухати музику",
    expectedApp: "Music",
    type: "valid",
    language: "uk",
  },
  {
    query: "як записати звук",
    expectedApp: ["VoiceMemos", "iMovie", "quicktime player"],
    type: "valid",
    language: "uk",
  },
  // 2. Перевірка аналогів (користувач просить іншу програму)
  {
    query: "Мені потрібен Excel",
    expectedApp: "Numbers",
    type: "valid",
    // Українське речення з назвою бренду всередині — мова речення українська.
    language: "uk",
  },
  {
    query: "Photoshop",
    expectedApp: ["Preview", "Photos", "Freeform"], // Декілька правильних відповідей
    type: "valid",
    // Гола назва бренду, без жодного слова навколо: не англійська і не українська.
    language: "neutral",
  },
  {
    query: "як записати голос",
    expectedApp: ["VoiceMemos", "iMovie", "QuickTime Player", "macOS System"],
    type: "valid",
    language: "uk",
  },
  // 3. Невалідні запити (абракадабра)
  {
    query: "asdfasdf qwerty",
    expectedApp: "INVALID_QUERY",
    type: "invalid",
    // Набір символів із латинської розкладки — перевірка INVALID_QUERY, не мови.
    language: "neutral",
  },
  {
    query: "івапівпавіп",
    expectedApp: "INVALID_QUERY",
    type: "invalid",
    // Кирилиця, але це теж безглуздя з клавіатури: у метрику української
    // не йде, хоча будь-який автодетектор впевнено назве її українською.
    language: "neutral",
  },
  // 4. Запити, на які немає програми (захист від галюцинацій)
  {
    query: "як побудувати ракету",
    expectedApp: "NOT_FOUND",
    type: "not_found", // Очікуємо, що LLM скаже, що програми немає
    language: "uk",
  },

  { query: "як видалити вірус", expectedApp: "NOT_FOUND", type: "not_found", language: "uk" },
  { query: "потрібен Word", expectedApp: "Pages", type: "valid", language: "uk" },
  { query: "як зробити презентацію", expectedApp: "Keynote", type: "valid", language: "uk" },
  {
    query: "як порахувати відсотки",
    expectedApp: ["Calculator", "Numbers"],
    type: "valid",
    language: "uk",
  },
  {
    query: "як поставити будильник",
    expectedApp: ["Clock", "macOS System"],
    type: "valid",
    language: "uk",
  },
  { query: "як дізнатися значення слова", expectedApp: "Dictionary", type: "valid", language: "uk" },
  { query: "як знайти загублений айфон", expectedApp: "FindMy", type: "valid", language: "uk" },
  { query: "зробити відеодзвінок", expectedApp: "FaceTime", type: "valid", language: "uk" },
  { query: "як переглянути погоду на завтра", expectedApp: "Weather", type: "valid", language: "uk" },
  { query: "як створити подію на завтра", expectedApp: "Calendar", type: "valid", language: "uk" },
  { query: "як почитати книгу", expectedApp: "Books", type: "valid", language: "uk" },
  { query: "як дізнатися курси акцій", expectedApp: "Stocks", type: "valid", language: "uk" },
  {
    query: "як відправити лист",
    expectedApp: ["Mail", "macOS System"],
    type: "valid",
    language: "uk",
  },
  { query: "як додати контакт", expectedApp: "Contacts", type: "valid", language: "uk" },
  { query: "зробити швидку нотатку", expectedApp: "Notes", type: "valid", language: "uk" },
  { query: "купити нову програму", expectedApp: "App Store", type: "valid", language: "uk" },
];

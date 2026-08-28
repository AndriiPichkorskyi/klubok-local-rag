export const TEST_CASES = [
  // 1. Валідні запити (чіткі задачі)
  {
    query: "Як створити електронну таблицю?",
    expectedApp: "Numbers",
    type: "valid",
  },
  {
    query: "як обрізати відео",
    expectedApp: "iMovie",
    type: "valid",
  },
  {
    query: "як слухати музику",
    expectedApp: "Music",
    type: "valid",
  },
  {
    query: "як записати звук",
    expectedApp: ["VoiceMemos", "iMovie", "quicktime player"],
    type: "valid",
  },
  // 2. Перевірка аналогів (користувач просить іншу програму)
  {
    query: "Мені потрібен Excel",
    expectedApp: "Numbers",
    type: "valid",
  },
  {
    query: "Photoshop",
    expectedApp: ["Preview", "Photos", "Freeform"], // Декілька правильних відповідей
    type: "valid",
  },
  {
    query: "як записати голос",
    expectedApp: ["VoiceMemos", "iMovie", "QuickTime Player", "macOS System"],
    type: "valid",
  },
  // 3. Невалідні запити (абракадабра)
  {
    query: "asdfasdf qwerty",
    expectedApp: "INVALID_QUERY",
    type: "invalid",
  },
  {
    query: "івапівпавіп",
    expectedApp: "INVALID_QUERY",
    type: "invalid",
  },
  // 4. Запити, на які немає програми (захист від галюцинацій)
  {
    query: "як побудувати ракету",
    expectedApp: "NOT_FOUND",
    type: "not_found", // Очікуємо, що LLM скаже, що програми немає
  },

  { query: "як видалити вірус", expectedApp: "NOT_FOUND", type: "not_found" },
  { query: "потрібен Word", expectedApp: "Pages", type: "valid" },
  { query: "як зробити презентацію", expectedApp: "Keynote", type: "valid" },
  { query: "як порахувати відсотки", expectedApp: ["Calculator", "Numbers"], type: "valid" },
  { query: "як поставити будильник", expectedApp: ["Clock", "macOS System"], type: "valid" },
  { query: "як дізнатися значення слова", expectedApp: "Dictionary", type: "valid" },
  { query: "як знайти загублений айфон", expectedApp: "FindMy", type: "valid" },
  { query: "зробити відеодзвінок", expectedApp: "FaceTime", type: "valid" },
  { query: "як переглянути погоду на завтра", expectedApp: "Weather", type: "valid" },
  { query: "як створити подію на завтра", expectedApp: "Calendar", type: "valid" },
  { query: "як почитати книгу", expectedApp: "Books", type: "valid" },
  { query: "як дізнатися курси акцій", expectedApp: "Stocks", type: "valid" },
  { query: "як відправити лист", expectedApp: ["Mail", "macOS System"], type: "valid" },
  { query: "як додати контакт", expectedApp: "Contacts", type: "valid" },
  { query: "зробити швидку нотатку", expectedApp: "Notes", type: "valid" },
  { query: "купити нову програму", expectedApp: "App Store", type: "valid" },
];

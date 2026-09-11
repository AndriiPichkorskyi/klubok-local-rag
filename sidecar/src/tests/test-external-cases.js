/**
 * Англомовний набір для перевірки крослінгвального пошуку.
 *
 * Документація у векторній базі українська, а всі запити тут англійські.
 * Очікування описують програму, яку справді може рекомендувати цей проєкт,
 * а не абстрактний capability з чужого датасету. Зокрема арифметика,
 * нагадування і системний запис екрана — валідні локальні задачі.
 */
export const EXTERNAL_TEST_CASES = [
  // Системні можливості macOS
  {
    query: "I need to film a walkthrough on screen",
    expectedApp: ["macOS System", "Screenshot", "QuickTime Player"],
    type: "valid",
    language: "en",
  },
  {
    query: "Take a screenshot of a selected area",
    expectedApp: ["macOS System", "Screenshot"],
    type: "valid",
    language: "en",
  },
  {
    query: "Remind me to call my mom tomorrow",
    expectedApp: "Reminders",
    type: "valid",
    language: "en",
  },
  {
    query: "What is 28 times 14?",
    expectedApp: "Calculator",
    type: "valid",
    language: "en",
  },
  {
    query: "  ",
    expectedApp: ["Clock", "macOS System"],
    type: "valid",
    language: "en",
  },
  {
    query: "Compress these files into a zip archive",
    expectedApp: ["Archive Utility", "macOS System"],
    type: "valid",
    language: "en",
  },

  // Робота й творчість
  {
    query: "Create a spreadsheet for my monthly budget",
    expectedApp: "Numbers",
    type: "valid",
    language: "en",
  },
  {
    query: "Make slides for a project presentation",
    expectedApp: "Keynote",
    type: "valid",
    language: "en",
  },
  {
    query: "Write and format a business letter",
    // `letter` може означати і діловий документ, і відформатований е-лист.
    expectedApp: ["Pages", "TextEdit", "Mail"],
    type: "valid",
    language: "en",
  },
  {
    query: "Trim the beginning of a video clip",
    expectedApp: ["iMovie", "Photos", "QuickTime Player"],
    type: "valid",
    language: "en",
  },
  {
    query: "Record a quick voice memo",
    expectedApp: ["VoiceMemos", "QuickTime Player", "macOS System"],
    type: "valid",
    language: "en",
  },
  {
    query: "Sketch ideas together on an infinite canvas",
    expectedApp: "Freeform",
    type: "valid",
    language: "en",
  },
  {
    query: "Automate a repetitive task on my Mac",
    expectedApp: ["Shortcuts", "Automator"],
    type: "valid",
    language: "en",
  },

  // Щоденні задачі
  {
    query: "Play some music from my library",
    expectedApp: "Music",
    type: "valid",
    language: "en",
  },
  {
    query: "Start a video call with a friend",
    expectedApp: ["FaceTime", "zoom.us"],
    type: "valid",
    language: "en",
  },
  {
    query: "Will it rain tomorrow?",
    expectedApp: "Weather",
    type: "valid",
    language: "en",
  },
  {
    query: "Add a dentist appointment to next Tuesday",
    expectedApp: "Calendar",
    type: "valid",
    language: "en",
  },
  {
    query: "Look up the meaning of the word ephemeral",
    expectedApp: "Dictionary",
    type: "valid",
    language: "en",
  },
  {
    query: "Find my lost iPhone",
    expectedApp: "FindMy",
    type: "valid",
    language: "en",
  },
  {
    query: "Send an email with an attachment",
    expectedApp: "Mail",
    type: "valid",
    language: "en",
  },
  {
    query: "Save a new person's phone number",
    expectedApp: "Contacts",
    type: "valid",
    language: "en",
  },
  {
    query: "Write down a quick note",
    expectedApp: ["Notes", "Stickies"],
    type: "valid",
    language: "en",
  },
  {
    query: "Download a new app for my Mac",
    expectedApp: "App Store",
    type: "valid",
    language: "en",
  },
  {
    query: "Read an ebook from my library",
    expectedApp: "Books",
    type: "valid",
    language: "en",
  },
  {
    query: "Check today's stock prices",
    expectedApp: "Stocks",
    type: "valid",
    language: "en",
  },
  {
    query: "Get driving directions to the airport",
    expectedApp: "Maps",
    type: "valid",
    language: "en",
  },
  {
    query: "Listen to the latest episode of a podcast",
    expectedApp: "Podcasts",
    type: "valid",
    language: "en",
  },

  // Документи й медіа
  {
    query: "Open a PDF and add annotations",
    expectedApp: "Preview",
    type: "valid",
    language: "en",
  },
  {
    query: "Copy text from a photo",
    expectedApp: ["Photos", "Preview"],
    type: "valid",
    language: "en",
  },
  {
    query: "Import pictures from my camera",
    // У довідці Preview є окрема стаття «Імпортування зображень із камери».
    expectedApp: ["Photos", "Image Capture", "Preview"],
    type: "valid",
    language: "en",
  },
  {
    query: "Watch a local movie file",
    expectedApp: ["QuickTime Player", "TV", "VLC", "Elmedia Video Player"],
    type: "valid",
    language: "en",
  },

  // Захист від галюцинацій і безглузді запити
  {
    query: "Control a rover currently driving on Mars",
    expectedApp: "NOT_FOUND",
    type: "not_found",
    language: "en",
  },
  {
    query: "Repair a physically broken laptop screen",
    expectedApp: "NOT_FOUND",
    type: "not_found",
    language: "en",
  },
  {
    query: "asdfasdf qwerty zxcv",
    expectedApp: "INVALID_QUERY",
    type: "invalid",
    // Це латинські символи, але не англійська мова — не псуємо EN-метрику.
    language: "neutral",
  },
];

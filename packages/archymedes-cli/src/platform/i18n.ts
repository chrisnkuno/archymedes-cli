export const CONTROL_LANGUAGES = {
  en: "English",
  zh: "中文 (Mandarin)",
  hi: "हिन्दी",
  es: "Español",
  fr: "Français",
  ar: "العربية",
  bn: "বাংলা",
  pt: "Português",
  ru: "Русский",
  ur: "اردو",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  tr: "Türkçe",
} as const;

export type ControlLanguage = keyof typeof CONTROL_LANGUAGES;

export function resolveControlLanguage(value: string | undefined): ControlLanguage {
  const normalized = value?.trim().toLowerCase().replace("_", "-") ?? "";
  const base = normalized.split("-")[0] as ControlLanguage;
  return base in CONTROL_LANGUAGES ? base : "en";
}

type Labels = { help: string; guide: string; exit: string; settings: string; voice: string; choose: string; saved: string; keyboard: string; remember: string };
const LABELS: Record<ControlLanguage, Labels> = {
  en: { help: "commands", guide: "guide", exit: "leave", settings: "settings", voice: "voice", choose: "Choose a setting", saved: "saved", keyboard: "Keyboard shortcuts", remember: "remember" },
  zh: { help: "命令", guide: "指南", exit: "退出", settings: "设置", voice: "语音", choose: "选择设置", saved: "已保存", keyboard: "键盘快捷键", remember: "记住" },
  hi: { help: "कमांड", guide: "गाइड", exit: "बाहर निकलें", settings: "सेटिंग्स", voice: "आवाज़", choose: "सेटिंग चुनें", saved: "सहेजा गया", keyboard: "कीबोर्ड शॉर्टकट", remember: "याद रखें" },
  es: { help: "comandos", guide: "guía", exit: "salir", settings: "ajustes", voice: "voz", choose: "Elige un ajuste", saved: "guardado", keyboard: "Atajos de teclado", remember: "recordar" },
  fr: { help: "commandes", guide: "guide", exit: "quitter", settings: "réglages", voice: "voix", choose: "Choisissez un réglage", saved: "enregistré", keyboard: "Raccourcis clavier", remember: "mémoriser" },
  ar: { help: "الأوامر", guide: "دليل", exit: "خروج", settings: "الإعدادات", voice: "الصوت", choose: "اختر إعدادًا", saved: "تم الحفظ", keyboard: "اختصارات لوحة المفاتيح", remember: "تذكّر" },
  bn: { help: "কমান্ড", guide: "গাইড", exit: "প্রস্থান", settings: "সেটিংস", voice: "ভয়েস", choose: "একটি সেটিং বেছে নিন", saved: "সংরক্ষিত", keyboard: "কীবোর্ড শর্টকাট", remember: "মনে রাখুন" },
  pt: { help: "comandos", guide: "guia", exit: "sair", settings: "configurações", voice: "voz", choose: "Escolha uma configuração", saved: "salvo", keyboard: "Atalhos de teclado", remember: "lembrar" },
  ru: { help: "команды", guide: "руководство", exit: "выход", settings: "настройки", voice: "голос", choose: "Выберите настройку", saved: "сохранено", keyboard: "Горячие клавиши", remember: "запомнить" },
  ur: { help: "کمانڈز", guide: "گائیڈ", exit: "باہر نکلیں", settings: "ترتیبات", voice: "آواز", choose: "ترتیب منتخب کریں", saved: "محفوظ ہوگیا", keyboard: "کی بورڈ شارٹ کٹس", remember: "یاد رکھیں" },
  ja: { help: "コマンド", guide: "ガイド", exit: "終了", settings: "設定", voice: "音声", choose: "設定を選択", saved: "保存しました", keyboard: "キーボードショートカット", remember: "記憶" },
  ko: { help: "명령", guide: "가이드", exit: "종료", settings: "설정", voice: "음성", choose: "설정 선택", saved: "저장됨", keyboard: "키보드 단축키", remember: "기억" },
  de: { help: "Befehle", guide: "Anleitung", exit: "beenden", settings: "Einstellungen", voice: "Sprache", choose: "Einstellung wählen", saved: "gespeichert", keyboard: "Tastenkürzel", remember: "merken" },
  id: { help: "perintah", guide: "panduan", exit: "keluar", settings: "pengaturan", voice: "suara", choose: "Pilih pengaturan", saved: "tersimpan", keyboard: "Pintasan keyboard", remember: "ingat" },
  vi: { help: "lệnh", guide: "hướng dẫn", exit: "thoát", settings: "cài đặt", voice: "giọng nói", choose: "Chọn một cài đặt", saved: "đã lưu", keyboard: "Phím tắt", remember: "ghi nhớ" },
  tr: { help: "komutlar", guide: "kılavuz", exit: "çık", settings: "ayarlar", voice: "ses", choose: "Bir ayar seçin", saved: "kaydedildi", keyboard: "Klavye kısayolları", remember: "hatırla" },
};

export function controlLabel(language: ControlLanguage, key: keyof Labels): string {
  return LABELS[language][key];
}

const COMMANDS: Partial<Record<ControlLanguage, Record<string, string>>> = {
  zh: { "/plan": "切换到只读规划模式", "/build": "切换到需批准的构建模式", "/auto": "自动应用编辑", "/model": "切换模型并保留上下文", "/undo": "撤销上一轮更改", "/diff": "显示最近更改", "/todos": "显示代理计划", "/clear": "开始新对话", "/pull": "复制沙箱文件", "/where": "显示当前工作区", "/providers": "显示模型提供商", "/settings": "配置密钥、网址、模型和语音", "/voice": "录音或转写语音提示", "/cost": "显示令牌和费用", "/sessions": "列出项目会话", "/keys": "键盘快捷键", "/help": "显示命令", "/exit": "退出" },
  hi: { "/plan": "केवल-पढ़ने की योजना मोड", "/build": "अनुमति वाला बिल्ड मोड", "/auto": "संपादन अपने-आप लागू करें", "/model": "संदर्भ रखते हुए मॉडल बदलें", "/undo": "पिछले बदलाव वापस लें", "/diff": "हाल के बदलाव दिखाएँ", "/todos": "एजेंट की योजना", "/clear": "नई बातचीत", "/pull": "सैंडबॉक्स फ़ाइलें कॉपी करें", "/where": "वर्तमान वर्कस्पेस", "/providers": "मॉडल प्रदाता", "/settings": "कुंजियाँ, URL, मॉडल और आवाज़", "/voice": "आवाज़ रिकॉर्ड या ट्रांसक्राइब करें", "/cost": "टोकन और लागत", "/sessions": "प्रोजेक्ट सत्र", "/keys": "कीबोर्ड शॉर्टकट", "/help": "कमांड दिखाएँ", "/exit": "बाहर निकलें" },
  es: { "/plan": "Modo de planificación de solo lectura", "/build": "Modo de cambios con aprobación", "/auto": "Aplicar cambios automáticamente", "/model": "Cambiar modelo conservando el contexto", "/undo": "Deshacer los últimos cambios", "/diff": "Mostrar cambios recientes", "/todos": "Mostrar el plan del agente", "/clear": "Iniciar una conversación nueva", "/pull": "Copiar archivos del entorno aislado", "/where": "Mostrar el espacio de trabajo", "/providers": "Mostrar proveedores de modelos", "/settings": "Configurar claves, URL, modelos y voz", "/voice": "Grabar o transcribir una instrucción", "/cost": "Mostrar tokens y coste", "/sessions": "Listar sesiones del proyecto", "/keys": "Atajos de teclado", "/help": "Mostrar comandos", "/exit": "Salir" },
  fr: { "/plan": "Mode planification en lecture seule", "/build": "Mode modification avec approbation", "/auto": "Appliquer les modifications automatiquement", "/model": "Changer de modèle en gardant le contexte", "/undo": "Annuler les dernières modifications", "/diff": "Afficher les changements récents", "/todos": "Afficher le plan de l’agent", "/clear": "Nouvelle conversation", "/pull": "Copier les fichiers du bac à sable", "/where": "Afficher l’espace de travail", "/providers": "Afficher les fournisseurs de modèles", "/settings": "Configurer clés, URL, modèles et voix", "/voice": "Enregistrer ou transcrire une demande", "/cost": "Afficher jetons et coût", "/sessions": "Lister les sessions du projet", "/keys": "Raccourcis clavier", "/help": "Afficher les commandes", "/exit": "Quitter" },
  ar: { "/plan": "وضع التخطيط للقراءة فقط", "/build": "وضع التعديل مع الموافقة", "/auto": "تطبيق التعديلات تلقائيًا", "/model": "تغيير النموذج مع حفظ السياق", "/undo": "التراجع عن آخر التعديلات", "/diff": "عرض التغييرات الأخيرة", "/todos": "عرض خطة الوكيل", "/clear": "بدء محادثة جديدة", "/pull": "نسخ ملفات البيئة المعزولة", "/where": "عرض مساحة العمل", "/providers": "عرض مزودي النماذج", "/settings": "إعداد المفاتيح والروابط والنماذج والصوت", "/voice": "تسجيل أو تحويل الصوت إلى نص", "/cost": "عرض الرموز والتكلفة", "/sessions": "عرض جلسات المشروع", "/keys": "اختصارات لوحة المفاتيح", "/help": "عرض الأوامر", "/exit": "خروج" },
  bn: { "/plan": "শুধু-পঠন পরিকল্পনা মোড", "/build": "অনুমোদনসহ বিল্ড মোড", "/auto": "সম্পাদনা স্বয়ংক্রিয়ভাবে প্রয়োগ", "/model": "প্রসঙ্গ রেখে মডেল বদলান", "/undo": "শেষ পরিবর্তন ফিরিয়ে নিন", "/diff": "সাম্প্রতিক পরিবর্তন দেখান", "/todos": "এজেন্টের পরিকল্পনা", "/clear": "নতুন আলাপ", "/pull": "স্যান্ডবক্স ফাইল কপি", "/where": "বর্তমান ওয়ার্কস্পেস", "/providers": "মডেল প্রদানকারী", "/settings": "কী, URL, মডেল ও ভয়েস", "/voice": "ভয়েস রেকর্ড বা ট্রান্সক্রাইব", "/cost": "টোকেন ও খরচ", "/sessions": "প্রজেক্ট সেশন", "/keys": "কীবোর্ড শর্টকাট", "/help": "কমান্ড দেখান", "/exit": "প্রস্থান" },
  pt: { "/plan": "Modo de planejamento somente leitura", "/build": "Modo de alterações com aprovação", "/auto": "Aplicar alterações automaticamente", "/model": "Trocar modelo mantendo o contexto", "/undo": "Desfazer últimas alterações", "/diff": "Mostrar alterações recentes", "/todos": "Mostrar plano do agente", "/clear": "Nova conversa", "/pull": "Copiar arquivos do sandbox", "/where": "Mostrar espaço de trabalho", "/providers": "Mostrar provedores de modelos", "/settings": "Configurar chaves, URLs, modelos e voz", "/voice": "Gravar ou transcrever uma solicitação", "/cost": "Mostrar tokens e custo", "/sessions": "Listar sessões do projeto", "/keys": "Atalhos de teclado", "/help": "Mostrar comandos", "/exit": "Sair" },
  ru: { "/plan": "Режим планирования без записи", "/build": "Режим изменений с подтверждением", "/auto": "Применять изменения автоматически", "/model": "Сменить модель, сохранив контекст", "/undo": "Отменить последние изменения", "/diff": "Показать последние изменения", "/todos": "Показать план агента", "/clear": "Новый диалог", "/pull": "Скопировать файлы из песочницы", "/where": "Показать рабочую область", "/providers": "Показать провайдеров моделей", "/settings": "Настроить ключи, URL, модели и голос", "/voice": "Записать или распознать запрос", "/cost": "Показать токены и стоимость", "/sessions": "Список сессий проекта", "/keys": "Горячие клавиши", "/help": "Показать команды", "/exit": "Выход" },
  ur: { "/plan": "صرف پڑھنے کا منصوبہ موڈ", "/build": "منظوری کے ساتھ بلڈ موڈ", "/auto": "تبدیلیاں خودکار لگائیں", "/model": "سیاق رکھتے ہوئے ماڈل بدلیں", "/undo": "آخری تبدیلی واپس کریں", "/diff": "حالیہ تبدیلیاں دکھائیں", "/todos": "ایجنٹ کا منصوبہ", "/clear": "نئی گفتگو", "/pull": "سینڈباکس فائلیں نقل کریں", "/where": "ورک اسپیس دکھائیں", "/providers": "ماڈل فراہم کنندگان", "/settings": "کلیدیں، URLs، ماڈلز اور آواز", "/voice": "آواز ریکارڈ یا متن میں بدلیں", "/cost": "ٹوکن اور لاگت", "/sessions": "پروجیکٹ سیشن", "/keys": "کی بورڈ شارٹ کٹس", "/help": "کمانڈز دکھائیں", "/exit": "باہر نکلیں" },
  ja: { "/plan": "読み取り専用の計画モード", "/build": "承認付きのビルドモード", "/auto": "編集を自動で適用", "/model": "コンテキストを保ったままモデルを切り替え", "/undo": "前のターンの変更を取り消す", "/diff": "最近の変更を表示", "/todos": "エージェントの計画を表示", "/clear": "新しい会話を開始", "/pull": "サンドボックスのファイルをコピー", "/where": "現在のワークスペースを表示", "/providers": "モデルプロバイダーを表示", "/settings": "キー・URL・モデル・音声を設定", "/voice": "音声プロンプトを録音または文字起こし", "/cost": "トークンとコストを表示", "/sessions": "プロジェクトのセッション一覧", "/keys": "キーボードショートカット", "/help": "コマンドを表示", "/exit": "終了" },
  ko: { "/plan": "읽기 전용 계획 모드", "/build": "승인이 필요한 빌드 모드", "/auto": "편집 자동 적용", "/model": "컨텍스트를 유지한 채 모델 전환", "/undo": "마지막 턴의 변경 취소", "/diff": "최근 변경 사항 표시", "/todos": "에이전트 계획 표시", "/clear": "새 대화 시작", "/pull": "샌드박스 파일 복사", "/where": "현재 작업 공간 표시", "/providers": "모델 제공자 표시", "/settings": "키, URL, 모델, 음성 설정", "/voice": "음성 프롬프트 녹음 또는 전사", "/cost": "토큰과 비용 표시", "/sessions": "프로젝트 세션 목록", "/keys": "키보드 단축키", "/help": "명령 표시", "/exit": "종료" },
  de: { "/plan": "Nur-Lese-Planungsmodus", "/build": "Änderungsmodus mit Bestätigung", "/auto": "Änderungen automatisch übernehmen", "/model": "Modell wechseln und Kontext behalten", "/undo": "Letzte Änderungen zurücknehmen", "/diff": "Letzte Änderungen anzeigen", "/todos": "Plan des Agenten anzeigen", "/clear": "Neues Gespräch beginnen", "/pull": "Dateien aus der Sandbox kopieren", "/where": "Aktuellen Arbeitsbereich anzeigen", "/providers": "Modellanbieter anzeigen", "/settings": "Schlüssel, URLs, Modelle und Spracheingabe", "/voice": "Sprachaufforderung aufnehmen oder transkribieren", "/cost": "Tokens und Kosten anzeigen", "/sessions": "Projektsitzungen auflisten", "/keys": "Tastenkürzel", "/help": "Befehle anzeigen", "/exit": "Beenden" },
  id: { "/plan": "Mode perencanaan hanya-baca", "/build": "Mode perubahan dengan persetujuan", "/auto": "Terapkan perubahan otomatis", "/model": "Ganti model sambil menjaga konteks", "/undo": "Batalkan perubahan giliran terakhir", "/diff": "Tampilkan perubahan terbaru", "/todos": "Tampilkan rencana agen", "/clear": "Mulai percakapan baru", "/pull": "Salin berkas sandbox", "/where": "Tampilkan ruang kerja saat ini", "/providers": "Tampilkan penyedia model", "/settings": "Atur kunci, URL, model, dan suara", "/voice": "Rekam atau transkripsikan perintah suara", "/cost": "Tampilkan token dan biaya", "/sessions": "Daftar sesi proyek", "/keys": "Pintasan keyboard", "/help": "Tampilkan perintah", "/exit": "Keluar" },
  vi: { "/plan": "Chế độ lập kế hoạch chỉ đọc", "/build": "Chế độ thay đổi cần phê duyệt", "/auto": "Tự động áp dụng chỉnh sửa", "/model": "Đổi mô hình mà vẫn giữ ngữ cảnh", "/undo": "Hoàn tác thay đổi của lượt trước", "/diff": "Hiển thị thay đổi gần đây", "/todos": "Hiển thị kế hoạch của tác nhân", "/clear": "Bắt đầu cuộc trò chuyện mới", "/pull": "Sao chép tệp từ sandbox", "/where": "Hiển thị không gian làm việc hiện tại", "/providers": "Hiển thị nhà cung cấp mô hình", "/settings": "Cấu hình khóa, URL, mô hình và giọng nói", "/voice": "Ghi âm hoặc chuyển lời nhắc thành văn bản", "/cost": "Hiển thị token và chi phí", "/sessions": "Liệt kê phiên của dự án", "/keys": "Phím tắt", "/help": "Hiển thị các lệnh", "/exit": "Thoát" },
  tr: { "/plan": "Salt okunur planlama modu", "/build": "Onaylı değişiklik modu", "/auto": "Değişiklikleri otomatik uygula", "/model": "Bağlamı koruyarak modeli değiştir", "/undo": "Son turun değişikliklerini geri al", "/diff": "Son değişiklikleri göster", "/todos": "Aracının planını göster", "/clear": "Yeni bir konuşma başlat", "/pull": "Sanal alan dosyalarını kopyala", "/where": "Geçerli çalışma alanını göster", "/providers": "Model sağlayıcılarını göster", "/settings": "Anahtarları, URL'leri, modelleri ve sesi ayarla", "/voice": "Sesli istemi kaydet veya yazıya dök", "/cost": "Belirteç ve maliyeti göster", "/sessions": "Proje oturumlarını listele", "/keys": "Klavye kısayolları", "/help": "Komutları göster", "/exit": "Çık" },
};

export function commandDescription(language: ControlLanguage, command: string, fallback: string): string {
  return COMMANDS[language]?.[command] ?? fallback;
}

/**
 * Keyed by shortcut id, not by position.
 *
 * These were positional arrays, which made the row order load-bearing for every language at
 * once: inserting a shortcut at the top silently moved every translation onto the wrong row, and
 * nothing in English would have shown it. An id costs a word and makes that impossible.
 * A missing id falls back to English, so a new shortcut is untranslated rather than mislabelled.
 */
export const TRANSLATED_KEYBOARD_IDS: Partial<Record<ControlLanguage, Record<string, string>>> = {
  zh: { "complete-command": "补全斜杠命令", "complete-path": "补全项目文件路径", "history": "搜索历史输入", "line-ends": "移到输入开头 / 结尾", "delete": "删除前一词 / 全部输入", "clear": "清屏并重绘", "interrupt": "中断当前任务", "voice": "从麦克风录入提示" },
  hi: { "complete-command": "स्लैश कमांड पूरा करें", "complete-path": "प्रोजेक्ट फ़ाइल पथ पूरा करें", "history": "पुराना इनपुट खोजें", "line-ends": "इनपुट की शुरुआत / अंत", "delete": "पिछला शब्द / पूरा इनपुट मिटाएँ", "clear": "टर्मिनल साफ़ करें", "interrupt": "वर्तमान काम रोकें", "voice": "माइक्रोफ़ोन से प्रॉम्प्ट रिकॉर्ड करें" },
  es: { "complete-command": "Completar un comando", "complete-path": "Completar una ruta del proyecto", "history": "Buscar en el historial", "line-ends": "Ir al inicio / final", "delete": "Borrar palabra / entrada completa", "clear": "Limpiar la terminal", "interrupt": "Interrumpir la tarea actual", "voice": "Grabar desde el micrófono" },
  fr: { "complete-command": "Compléter une commande", "complete-path": "Compléter un chemin du projet", "history": "Rechercher dans l’historique", "line-ends": "Début / fin de la saisie", "delete": "Effacer le mot / toute la saisie", "clear": "Effacer le terminal", "interrupt": "Interrompre la tâche", "voice": "Enregistrer avec le microphone" },
  ar: { "complete-command": "إكمال أمر", "complete-path": "إكمال مسار ملف المشروع", "history": "البحث في السجل", "line-ends": "بداية / نهاية الإدخال", "delete": "حذف الكلمة / كامل الإدخال", "clear": "مسح الطرفية", "interrupt": "إيقاف المهمة الحالية", "voice": "تسجيل الطلب من الميكروفون" },
  bn: { "complete-command": "স্ল্যাশ কমান্ড পূরণ", "complete-path": "প্রজেক্ট ফাইল পথ পূরণ", "history": "ইতিহাস খুঁজুন", "line-ends": "ইনপুটের শুরু / শেষ", "delete": "আগের শব্দ / সব ইনপুট মুছুন", "clear": "টার্মিনাল পরিষ্কার", "interrupt": "বর্তমান কাজ থামান", "voice": "মাইক্রোফোন থেকে রেকর্ড" },
  pt: { "complete-command": "Completar um comando", "complete-path": "Completar caminho do projeto", "history": "Pesquisar histórico", "line-ends": "Ir ao início / fim", "delete": "Apagar palavra / entrada inteira", "clear": "Limpar o terminal", "interrupt": "Interromper a tarefa", "voice": "Gravar pelo microfone" },
  ru: { "complete-command": "Дополнить команду", "complete-path": "Дополнить путь к файлу", "history": "Искать в истории", "line-ends": "В начало / конец строки", "delete": "Удалить слово / всю строку", "clear": "Очистить терминал", "interrupt": "Прервать задачу", "voice": "Записать запрос с микрофона" },
  ur: { "complete-command": "سلیش کمانڈ مکمل کریں", "complete-path": "پروجیکٹ فائل کا راستہ مکمل کریں", "history": "تاریخ تلاش کریں", "line-ends": "ان پٹ کے شروع / آخر جائیں", "delete": "پچھلا لفظ / پوری سطر مٹائیں", "clear": "ٹرمینل صاف کریں", "interrupt": "موجودہ کام روکیں", "voice": "مائیکروفون سے ریکارڈ کریں" },
  ja: { "complete-command": "スラッシュコマンドを補完", "complete-path": "プロジェクトのファイルパスを補完", "history": "入力履歴を検索", "line-ends": "入力の先頭 / 末尾へ", "delete": "前の単語 / 入力全体を削除", "clear": "画面をクリアして再描画", "interrupt": "現在のタスクを中断", "voice": "マイクからプロンプトを録音" },
  ko: { "complete-command": "슬래시 명령 자동완성", "complete-path": "프로젝트 파일 경로 자동완성", "history": "입력 기록 검색", "line-ends": "입력의 처음 / 끝으로", "delete": "이전 단어 / 전체 입력 삭제", "clear": "화면 지우고 다시 그리기", "interrupt": "현재 작업 중단", "voice": "마이크로 프롬프트 녹음" },
  de: { "complete-command": "Slash-Befehl vervollständigen", "complete-path": "Projektdateipfad vervollständigen", "history": "Eingabeverlauf durchsuchen", "line-ends": "An Anfang / Ende der Eingabe", "delete": "Vorheriges Wort / gesamte Eingabe löschen", "clear": "Terminal leeren und neu zeichnen", "interrupt": "Aktuelle Aufgabe abbrechen", "voice": "Prompt über das Mikrofon aufnehmen" },
  id: { "complete-command": "Lengkapi perintah garis miring", "complete-path": "Lengkapi jalur berkas proyek", "history": "Cari riwayat masukan", "line-ends": "Ke awal / akhir masukan", "delete": "Hapus kata sebelumnya / seluruh masukan", "clear": "Bersihkan terminal dan gambar ulang", "interrupt": "Hentikan tugas saat ini", "voice": "Rekam prompt dari mikrofon" },
  vi: { "complete-command": "Hoàn thành lệnh gạch chéo", "complete-path": "Hoàn thành đường dẫn tệp dự án", "history": "Tìm trong lịch sử nhập", "line-ends": "Về đầu / cuối dòng nhập", "delete": "Xóa từ trước / toàn bộ dòng nhập", "clear": "Xóa và vẽ lại màn hình", "interrupt": "Dừng tác vụ hiện tại", "voice": "Ghi âm lời nhắc từ micro" },
  tr: { "complete-command": "Eğik çizgi komutunu tamamla", "complete-path": "Proje dosya yolunu tamamla", "history": "Girdi geçmişinde ara", "line-ends": "Girdinin başına / sonuna git", "delete": "Önceki kelimeyi / tüm girdiyi sil", "clear": "Terminali temizle ve yeniden çiz", "interrupt": "Geçerli görevi durdur", "voice": "Mikrofondan istem kaydet" },
};

export function keyboardDescription(language: ControlLanguage, id: string, fallback: string): string {
  return TRANSLATED_KEYBOARD_IDS[language]?.[id] ?? fallback;
}

/**
 * The message catalog for the surfaces a new user reads first: the `--help` page's structure,
 * the mode labels, the first-run prompt, the connectivity doctor's verdicts, and the balance
 * command's replies.
 *
 * `en` is the source and is always present; a language that has not translated a key falls back
 * to it, so a new string is untranslated rather than missing. The dense flag-reference rows in
 * `--help` are deliberately not here — see I18N.md.
 */
type MessageKey =
  | "tagline"
  | "help.startHere" | "help.running" | "help.files" | "help.model" | "help.cost"
  | "help.memory" | "help.transcript" | "help.headless" | "help.inSession"
  | "help.footnote" | "help.sessionHint"
  | "mode.plan" | "mode.auto" | "mode.build" | "mode.defender"
  | "firstRun.notConfigured"
  | "doctor.header" | "doctor.allReachable" | "doctor.noProvider" | "doctor.cannotReach"
  | "balance.tracking";

const MESSAGES: Record<MessageKey, Partial<Record<ControlLanguage, string>> & { en: string }> = {
  "tagline": {
    en: "a coding agent that shows its work",
    zh: "会展示推导过程的编码代理", hi: "अपना काम दिखाने वाला कोडिंग एजेंट", es: "un agente de programación que muestra su razonamiento",
    fr: "un agent de codage qui montre son raisonnement", ar: "وكيل برمجة يُظهر خطوات عمله", bn: "যে কোডিং এজেন্ট তার কাজ দেখায়",
    pt: "um agente de programação que mostra seu raciocínio", ru: "агент-программист, который показывает ход решения", ur: "ایک کوڈنگ ایجنٹ جو اپنا کام دکھاتا ہے",
    ja: "途中の考え方まで示すコーディングエージェント", ko: "풀이 과정을 보여주는 코딩 에이전트", de: "ein Coding-Agent, der seinen Rechenweg zeigt",
    id: "agen pemrograman yang menunjukkan cara kerjanya", vi: "một tác nhân lập trình trình bày cách làm", tr: "yaptığı işi adım adım gösteren bir kodlama aracı",
  },
  "help.startHere": {
    en: "Start here",
    zh: "从这里开始", hi: "यहाँ से शुरू करें", es: "Empieza aquí", fr: "Commencez ici", ar: "ابدأ من هنا", bn: "এখান থেকে শুরু করুন",
    pt: "Comece aqui", ru: "Начните здесь", ur: "یہاں سے شروع کریں", ja: "ここから始める", ko: "여기서 시작", de: "Hier anfangen",
    id: "Mulai di sini", vi: "Bắt đầu tại đây", tr: "Buradan başlayın",
  },
  "help.running": {
    en: "Running it",
    zh: "运行方式", hi: "इसे चलाना", es: "Cómo ejecutarlo", fr: "L'exécuter", ar: "طريقة التشغيل", bn: "এটি চালানো",
    pt: "Como executar", ru: "Как запускать", ur: "اسے چلانا", ja: "実行する", ko: "실행하기", de: "Ausführen",
    id: "Menjalankannya", vi: "Chạy nó", tr: "Çalıştırma",
  },
  "help.files": {
    en: "Where the files go",
    zh: "文件位置", hi: "फ़ाइलें कहाँ जाती हैं", es: "Dónde van los archivos", fr: "Où vont les fichiers", ar: "أين تذهب الملفات",
    bn: "ফাইল কোথায় যায়", pt: "Para onde vão os arquivos", ru: "Где находятся файлы", ur: "فائلیں کہاں جاتی ہیں",
    ja: "ファイルの場所", ko: "파일이 저장되는 곳", de: "Wohin die Dateien gehen", id: "Ke mana berkas disimpan",
    vi: "Tệp được lưu ở đâu", tr: "Dosyalar nereye gider",
  },
  "help.model": {
    en: "Model",
    zh: "模型", hi: "मॉडल", es: "Modelo", fr: "Modèle", ar: "النموذج", bn: "মডেল", pt: "Modelo", ru: "Модель", ur: "ماڈل",
    ja: "モデル", ko: "모델", de: "Modell", id: "Model", vi: "Mô hình", tr: "Model",
  },
  "help.cost": {
    en: "Cost",
    zh: "费用", hi: "लागत", es: "Coste", fr: "Coût", ar: "التكلفة", bn: "খরচ", pt: "Custo", ru: "Стоимость", ur: "لاگت",
    ja: "コスト", ko: "비용", de: "Kosten", id: "Biaya", vi: "Chi phí", tr: "Maliyet",
  },
  "help.memory": {
    en: "Memory and history",
    zh: "记忆与历史", hi: "मेमोरी और इतिहास", es: "Memoria e historial", fr: "Mémoire et historique", ar: "الذاكرة والسجل",
    bn: "মেমরি ও ইতিহাস", pt: "Memória e histórico", ru: "Память и история", ur: "میموری اور تاریخ",
    ja: "メモリと履歴", ko: "메모리와 기록", de: "Speicher und Verlauf", id: "Memori dan riwayat",
    vi: "Bộ nhớ và lịch sử", tr: "Bellek ve geçmiş",
  },
  "help.transcript": {
    en: "Reading the transcript",
    zh: "阅读记录", hi: "ट्रांसक्रिप्ट पढ़ना", es: "Leer la transcripción", fr: "Lire la transcription", ar: "قراءة النص",
    bn: "ট্রান্সক্রিপ্ট পড়া", pt: "Ler a transcrição", ru: "Чтение стенограммы", ur: "ٹرانسکرپٹ پڑھنا",
    ja: "記録を読む", ko: "대화 기록 읽기", de: "Das Transkript lesen", id: "Membaca transkrip",
    vi: "Đọc bản ghi", tr: "Dökümü okuma",
  },
  "help.headless": {
    en: "Headless output",
    zh: "无界面输出", hi: "हेडलेस आउटपुट", es: "Salida sin interfaz", fr: "Sortie sans interface", ar: "المخرجات بدون واجهة",
    bn: "হেডলেস আউটপুট", pt: "Saída headless", ru: "Вывод без интерфейса", ur: "ہیڈ لیس آؤٹ پٹ",
    ja: "ヘッドレス出力", ko: "헤드리스 출력", de: "Headless-Ausgabe", id: "Keluaran tanpa antarmuka",
    vi: "Đầu ra không giao diện", tr: "Arayüzsüz çıktı",
  },
  "help.inSession": {
    en: "In a session",
    zh: "会话中", hi: "सत्र में", es: "En una sesión", fr: "Dans une session", ar: "داخل الجلسة", bn: "একটি সেশনে",
    pt: "Em uma sessão", ru: "В сессии", ur: "سیشن میں", ja: "セッション中", ko: "세션 안에서", de: "In einer Sitzung",
    id: "Dalam sesi", vi: "Trong một phiên", tr: "Bir oturumda",
  },
  "help.footnote": {
    en: "Everything below is here when you need it — these five are the ones you need first.",
    zh: "下面的内容备你所需——这五个是你首先要用的。",
    hi: "नीचे सब कुछ ज़रूरत पड़ने पर है — ये पाँच पहले चाहिए।",
    es: "Todo lo de abajo está aquí cuando lo necesites; estos cinco son los primeros.",
    fr: "Tout ce qui suit est là au besoin — ces cinq-là sont les premiers.",
    ar: "كل ما بالأسفل موجود عند الحاجة — وهذه الخمسة هي ما تحتاجه أولاً.",
    bn: "নিচের সব কিছু প্রয়োজনে আছে — এই পাঁচটি প্রথমে দরকার।",
    pt: "Tudo abaixo está aqui quando precisar — estes cinco vêm primeiro.",
    ru: "Всё, что ниже, — на случай необходимости; эти пять нужны в первую очередь.",
    ur: "نیچے سب کچھ ضرورت پر موجود ہے — یہ پانچ پہلے درکار ہیں۔",
    ja: "以下は必要になったときのために。まずはこの5つ。",
    ko: "아래는 필요할 때를 위한 것 — 이 다섯 개가 먼저 필요합니다.",
    de: "Alles Weitere steht bereit, wenn du es brauchst — diese fünf zuerst.",
    id: "Semua di bawah tersedia saat dibutuhkan — lima ini yang pertama.",
    vi: "Mọi thứ bên dưới có sẵn khi bạn cần — năm mục này cần trước.",
    tr: "Aşağıdakiler gerektiğinde burada — önce bu beşi.",
  },
  "help.sessionHint": {
    en: "marks the ones to learn first",
    zh: "标记先学的项目", hi: "पहले सीखने वाले चिह्नित", es: "marca los que aprender primero", fr: "marque ceux à apprendre d'abord",
    ar: "يشير إلى ما يُتعلَّم أولاً", bn: "প্রথমে শেখারগুলো চিহ্নিত", pt: "marca os que aprender primeiro",
    ru: "отмечает то, что изучить в первую очередь", ur: "پہلے سیکھنے والوں کی نشاندہی",
    ja: "最初に覚えるものを示す", ko: "먼저 익힐 것을 표시", de: "markiert, was zuerst zu lernen ist",
    id: "menandai yang dipelajari lebih dulu", vi: "đánh dấu những mục nên học trước", tr: "önce öğrenilecekleri işaretler",
  },
  "mode.plan": {
    en: "plan", zh: "规划", hi: "योजना", es: "plan", fr: "plan", ar: "تخطيط", bn: "পরিকল্পনা", pt: "plano", ru: "план",
    ur: "منصوبہ", ja: "計画", ko: "계획", de: "Plan", id: "rencana", vi: "kế hoạch", tr: "plan",
  },
  "mode.auto": {
    en: "auto", zh: "自动", hi: "स्वतः", es: "auto", fr: "auto", ar: "تلقائي", bn: "স্বয়ংক্রিয়", pt: "auto", ru: "авто",
    ur: "خودکار", ja: "自動", ko: "자동", de: "auto", id: "otomatis", vi: "tự động", tr: "otomatik",
  },
  "mode.build": {
    en: "build", zh: "构建", hi: "बिल्ड", es: "construir", fr: "construire", ar: "بناء", bn: "বিল্ড", pt: "construir",
    ru: "сборка", ur: "بلڈ", ja: "ビルド", ko: "빌드", de: "Build", id: "bangun", vi: "xây dựng", tr: "derleme",
  },
  "mode.defender": {
    en: "defender", zh: "防御", hi: "डिफेंडर", es: "defensor", fr: "défenseur", ar: "مدافع", bn: "ডিফেন্ডার", pt: "defensor",
    ru: "защита", ur: "محافظ", ja: "ディフェンダー", ko: "디펜더", de: "Verteidiger", id: "penjaga", vi: "phòng thủ", tr: "savunucu",
  },
  "firstRun.notConfigured": {
    en: "Archymedes is not configured yet. Add a provider key below to start.",
    zh: "Archymedes 尚未配置。请在下方添加一个提供商密钥以开始。",
    hi: "Archymedes अभी कॉन्फ़िगर नहीं है। शुरू करने के लिए नीचे एक प्रदाता कुंजी जोड़ें।",
    es: "Archymedes aún no está configurado. Añade una clave de proveedor abajo para empezar.",
    fr: "Archymedes n'est pas encore configuré. Ajoutez une clé de fournisseur ci-dessous pour commencer.",
    ar: "لم يتم إعداد Archymedes بعد. أضف مفتاح مزوّد بالأسفل للبدء.",
    bn: "Archymedes এখনও কনফিগার করা হয়নি। শুরু করতে নিচে একটি প্রোভাইডার কী যোগ করুন।",
    pt: "O Archymedes ainda não está configurado. Adicione uma chave de provedor abaixo para começar.",
    ru: "Archymedes ещё не настроен. Добавьте ключ провайдера ниже, чтобы начать.",
    ur: "Archymedes ابھی ترتیب نہیں دیا گیا۔ شروع کرنے کے لیے نیچے ایک پرووائیڈر کلید شامل کریں۔",
    ja: "Archymedes はまだ設定されていません。開始するには下でプロバイダーのキーを追加してください。",
    ko: "Archymedes가 아직 설정되지 않았습니다. 시작하려면 아래에 공급자 키를 추가하세요.",
    de: "Archymedes ist noch nicht konfiguriert. Füge unten einen Anbieter-Schlüssel hinzu, um zu starten.",
    id: "Archymedes belum dikonfigurasi. Tambahkan kunci penyedia di bawah untuk memulai.",
    vi: "Archymedes chưa được cấu hình. Thêm khóa nhà cung cấp bên dưới để bắt đầu.",
    tr: "Archymedes henüz yapılandırılmadı. Başlamak için aşağıya bir sağlayıcı anahtarı ekleyin.",
  },
  "doctor.header": {
    en: "Archymedes connectivity check",
    zh: "Archymedes 连接检查", hi: "Archymedes कनेक्टिविटी जाँच", es: "Comprobación de conectividad de Archymedes",
    fr: "Vérification de connectivité d'Archymedes", ar: "فحص اتصال Archymedes", bn: "Archymedes সংযোগ পরীক্ষা",
    pt: "Verificação de conectividade do Archymedes", ru: "Проверка соединения Archymedes", ur: "Archymedes کنیکٹیویٹی جانچ",
    ja: "Archymedes 接続チェック", ko: "Archymedes 연결 점검", de: "Archymedes-Verbindungsprüfung",
    id: "Pemeriksaan konektivitas Archymedes", vi: "Kiểm tra kết nối Archymedes", tr: "Archymedes bağlantı kontrolü",
  },
  "doctor.allReachable": {
    en: "All required endpoints are reachable.",
    zh: "所有必需的端点均可访问。", hi: "सभी आवश्यक एंडपॉइंट पहुँच योग्य हैं।", es: "Todos los puntos finales necesarios son accesibles.",
    fr: "Tous les points de terminaison requis sont accessibles.", ar: "جميع نقاط النهاية المطلوبة قابلة للوصول.",
    bn: "সব প্রয়োজনীয় এন্ডপয়েন্টে পৌঁছানো যাচ্ছে।", pt: "Todos os endpoints necessários estão acessíveis.",
    ru: "Все необходимые адреса доступны.", ur: "تمام مطلوبہ اینڈ پوائنٹس قابل رسائی ہیں۔",
    ja: "必要なエンドポイントはすべて到達可能です。", ko: "필요한 모든 엔드포인트에 연결할 수 있습니다.",
    de: "Alle erforderlichen Endpunkte sind erreichbar.", id: "Semua endpoint yang diperlukan dapat dijangkau.",
    vi: "Tất cả các endpoint cần thiết đều truy cập được.", tr: "Gerekli tüm uç noktalara erişilebiliyor.",
  },
  "doctor.noProvider": {
    en: "No provider is configured — set an API key to use Archymedes.",
    zh: "未配置任何提供商——设置一个 API 密钥以使用 Archymedes。",
    hi: "कोई प्रदाता कॉन्फ़िगर नहीं है — Archymedes उपयोग करने के लिए एक API कुंजी सेट करें।",
    es: "No hay ningún proveedor configurado: establece una clave de API para usar Archymedes.",
    fr: "Aucun fournisseur configuré — définissez une clé API pour utiliser Archymedes.",
    ar: "لا يوجد مزوّد مُهيّأ — عيّن مفتاح API لاستخدام Archymedes.",
    bn: "কোনো প্রোভাইডার কনফিগার করা নেই — Archymedes ব্যবহার করতে একটি API কী সেট করুন।",
    pt: "Nenhum provedor configurado — defina uma chave de API para usar o Archymedes.",
    ru: "Провайдер не настроен — задайте ключ API, чтобы использовать Archymedes.",
    ur: "کوئی پرووائیڈر ترتیب نہیں — Archymedes استعمال کرنے کے لیے ایک API کلید سیٹ کریں۔",
    ja: "プロバイダーが未設定です。Archymedes を使うには API キーを設定してください。",
    ko: "설정된 공급자가 없습니다 — Archymedes를 사용하려면 API 키를 설정하세요.",
    de: "Kein Anbieter konfiguriert — lege einen API-Schlüssel fest, um Archymedes zu nutzen.",
    id: "Tidak ada penyedia yang dikonfigurasi — atur kunci API untuk memakai Archymedes.",
    vi: "Chưa cấu hình nhà cung cấp — đặt khóa API để dùng Archymedes.",
    tr: "Yapılandırılmış sağlayıcı yok — Archymedes'i kullanmak için bir API anahtarı ayarlayın.",
  },
  "doctor.cannotReach": {
    en: "Archymedes cannot reach its model provider:",
    zh: "Archymedes 无法连接其模型提供商：", hi: "Archymedes अपने मॉडल प्रदाता तक नहीं पहुँच सकता:",
    es: "Archymedes no puede acceder a su proveedor de modelos:", fr: "Archymedes ne peut pas joindre son fournisseur de modèles :",
    ar: "لا يستطيع Archymedes الوصول إلى مزوّد النموذج:", bn: "Archymedes তার মডেল প্রোভাইডারে পৌঁছাতে পারছে না:",
    pt: "O Archymedes não consegue acessar seu provedor de modelos:", ru: "Archymedes не может связаться с провайдером модели:",
    ur: "Archymedes اپنے ماڈل پرووائیڈر تک نہیں پہنچ سکتا:", ja: "Archymedes はモデルプロバイダーに接続できません:",
    ko: "Archymedes가 모델 공급자에 연결할 수 없습니다:", de: "Archymedes kann seinen Modellanbieter nicht erreichen:",
    id: "Archymedes tidak dapat menjangkau penyedia modelnya:", vi: "Archymedes không thể kết nối tới nhà cung cấp mô hình:",
    tr: "Archymedes model sağlayıcısına ulaşamıyor:",
  },
  "balance.tracking": {
    en: "Archymedes will subtract each turn's measured cost from it.",
    zh: "Archymedes 将从中扣除每轮的实测费用。",
    hi: "Archymedes हर टर्न की मापी गई लागत इसमें से घटाएगा।",
    es: "Archymedes restará de él el coste medido de cada turno.",
    fr: "Archymedes en soustraira le coût mesuré de chaque tour.",
    ar: "سيخصم Archymedes منه التكلفة المقاسة لكل جولة.",
    bn: "Archymedes প্রতিটি টার্নের পরিমাপকৃত খরচ এটি থেকে বাদ দেবে।",
    pt: "O Archymedes subtrairá dele o custo medido de cada turno.",
    ru: "Archymedes будет вычитать из него измеренную стоимость каждого хода.",
    ur: "Archymedes ہر باری کی ماپی گئی لاگت اس میں سے منہا کرے گا۔",
    ja: "Archymedes は各ターンの実測コストをここから差し引きます。",
    ko: "Archymedes가 매 턴의 측정된 비용을 여기서 차감합니다.",
    de: "Archymedes zieht die gemessenen Kosten jeder Runde davon ab.",
    id: "Archymedes akan mengurangi biaya terukur setiap giliran dari saldo ini.",
    vi: "Archymedes sẽ trừ chi phí đo được của mỗi lượt khỏi số dư này.",
    tr: "Archymedes her turun ölçülen maliyetini bundan düşecek.",
  },
};

/** A message on a core surface, in `language`, falling back to English per key. */
export function t(language: ControlLanguage, key: MessageKey): string {
  return MESSAGES[key][language] ?? MESSAGES[key].en;
}

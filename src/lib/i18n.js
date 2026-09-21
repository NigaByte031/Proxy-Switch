/**
 * Tiny two-language i18n layer (English + Persian) with RTL support.
 *
 * The extension needs the language to change *live* (and to be switchable from
 * the popup), which the built-in `chrome.i18n` API cannot do, so the strings
 * live here instead. The module is dependency-free and testable in Node.
 */

export const SUPPORTED_LANGS = ['en', 'fa'];
export const DEFAULT_LANG = 'en';

/**
 * i18n key suffix per proxy mode. The three names differ on purpose:
 * `fixed_servers` and `pac_script` are chrome.proxy internals, the UI calls
 * them "Manual" and "PAC".
 */
export const MODE_KEY_SUFFIX = {
  system: 'system',
  direct: 'direct',
  fixed_servers: 'manual',
  pac_script: 'pac',
};

/** `modeKey('fixed_servers')` -> 'mode.manual'; `modeKey('pac_script', 'mode.hint')` -> 'mode.hint.pac'. */
export function modeKey(mode, prefix = 'mode') {
  return `${prefix}.${MODE_KEY_SUFFIX[mode] ?? MODE_KEY_SUFFIX.system}`;
}

/** Label shown on the language button: the language you would switch *to*. */
export const LANG_LABELS = {
  en: 'EN',
  fa: 'فا',
};

export const MESSAGES = {
  en: {
    'app.name': 'Proxy Switch',
    'app.tagline': 'One-click proxy control for Chrome',
    'action.settings': 'Settings',
    'lang.switch': 'Switch language',

    'mode.title': 'Mode',
    'mode.system': 'System',
    'mode.direct': 'Direct',
    'mode.manual': 'Manual',
    'mode.pac': 'PAC',
    'mode.hint.system': "Use the operating system's proxy settings.",
    'mode.hint.direct': 'Connect directly, without any proxy.',
    'mode.hint.manual': 'Send traffic through one of your saved servers.',
    'mode.hint.pac': 'Let a PAC script decide which requests use a proxy.',

    'status.off.title': 'Proxy disabled',
    'status.off.detail': 'While the switch is off every request goes direct.',
    'status.system.title': 'Using the system proxy',
    'status.system.detail': 'Chrome follows the proxy settings of your operating system.',
    'status.direct.title': 'Direct connection',
    'status.direct.detail': 'No request is routed through a proxy.',
    'status.manual.title': 'Manual proxy',
    'status.manual.detail': '{name} · {scheme}://{host}:{port}',
    'status.pac.title': 'PAC script',
    'status.pac.detail': '{url}',
    'status.warnProfile.title': 'No server selected',
    'status.warnProfile.detail': 'Pick a server below — until then traffic stays direct.',
    'status.warnPac.title': 'PAC URL is empty',
    'status.warnPac.detail': 'Add a PAC URL — until then traffic stays direct.',

    'profiles.title': 'Servers',
    'profiles.add': 'Add server',
    'profiles.new': 'New server',
    'profiles.edit': 'Edit server',
    'profiles.empty': 'No servers yet. Add one to switch proxies in a click.',
    'profiles.use': 'Use this server',
    'profiles.editAction': 'Edit',
    'profiles.deleteAction': 'Delete',

    'field.name': 'Name',
    'field.namePlaceholder': 'e.g. Home proxy',
    'field.scheme': 'Type',
    'field.port': 'Port',
    'field.host': 'Host',
    'field.hostPlaceholder': '127.0.0.1 or proxy.example.com',
    'field.username': 'Username',
    'field.password': 'Password',
    'field.authNote': 'Credentials stay on this device only and are never synced.',
    'field.pacUrl': 'PAC script URL',
    'field.pacPlaceholder': 'https://example.com/proxy.pac',
    'field.pacHint': 'Chrome downloads this proxy auto-config file and obeys it.',
    'field.bypass': 'Bypass list',
    'field.bypassPlaceholder': '<local>\nlocalhost\n127.0.0.1\n*.internal.example.com',
    'field.bypassSummary': '{count} bypass rules',
    'field.bypassNone': 'No bypass rules',

    'btn.save': 'Save',
    'btn.cancel': 'Cancel',
    'btn.export': 'Export',
    'btn.import': 'Import',
    'btn.reset': 'Reset',

    'msg.saved': 'Saved.',
    'msg.imported': 'Settings imported.',
    'msg.exported': 'Settings exported.',
    'msg.importError': 'That file could not be imported.',
    'msg.resetDone': 'Everything was reset to defaults.',

    'confirm.deleteProfile': 'Delete this server?',
    'confirm.reset': 'Reset all settings and servers to their defaults?',

    'error.nameRequired': 'Enter a name.',
    'error.nameDuplicate': 'Another server already uses this name.',
    'error.hostRequired': 'Enter a host.',
    'error.hostInvalid': 'That host is not valid.',
    'error.portRequired': 'Enter a port.',
    'error.portInvalid': 'The port must be a number.',
    'error.portRange': 'The port must be between 1 and 65535.',
    'error.pacInvalid': 'The PAC URL must start with http:// or https://.',
    'error.importFormat': 'That file is not a Proxy Switch export.',
    'error.importJson': 'That file is not valid JSON.',

    'options.title': 'Proxy Switch settings',
    'options.general': 'General',
    'options.language': 'Language',
    'options.languageAuto': 'Automatic (browser language)',
    'options.enabled': 'Proxy switching enabled',
    'options.auth': 'Send proxy credentials automatically',
    'options.authHint':
      'Answers the login prompt of your active server so Chrome stops asking for it.',
    'options.mode': 'Proxy mode',
    'options.servers': 'Servers',
    'options.serversHint': 'Click a server to activate it right away.',
    'options.bypass': 'Bypass list',
    'options.bypassHint':
      'One rule per line. Use <local> for intranet hosts or patterns such as *.example.com.',
    'options.data': 'Backup and reset',
    'options.dataHint':
      'Exports contain usernames and passwords as plain text — keep the file somewhere safe.',
    'options.about': 'About',
    'options.version': 'Version',
    'options.permissions': 'This extension requests only what it needs:',
    'options.perm.proxy': 'proxy — change the browser proxy settings',
    'options.perm.storage': 'storage — keep servers and settings on this device',
    'options.perm.webRequest':
      'webRequest — answer proxy authentication prompts with your saved credentials',
    'options.perm.host': 'all sites — required to route traffic and authenticate the proxy',

    'menu.root': 'Proxy Switch',
    'menu.direct': 'Direct (no proxy)',
    'menu.system': 'System proxy',
    'menu.settings': 'Settings…',
  },

  fa: {
    'app.name': 'پروکسی سوئیچ',
    'app.tagline': 'کنترل پروکسی کروم با یک کلیک',
    'action.settings': 'تنظیمات',
    'lang.switch': 'تغییر زبان',

    'mode.title': 'حالت',
    'mode.system': 'سیستم',
    'mode.direct': 'مستقیم',
    'mode.manual': 'دستی',
    'mode.pac': 'PAC',
    'mode.hint.system': 'از تنظیمات پروکسی سیستمعامل استفاده میشود.',
    'mode.hint.direct': 'اتصال مستقیم، بدون هیچ پروکسی.',
    'mode.hint.manual': 'ترافیک از یکی از سرورهای ذخیرهشده عبور میکند.',
    'mode.hint.pac': 'یک اسکریپت PAC تعیین میکند کدام درخواستها از پروکسی بروند.',

    'status.off.title': 'پروکسی خاموش است',
    'status.off.detail': 'تا وقتی کلید خاموش است همهٔ درخواستها مستقیم میروند.',
    'status.system.title': 'پروکسی سیستمی',
    'status.system.detail': 'کروم از تنظیمات پروکسی سیستمعامل پیروی میکند.',
    'status.direct.title': 'اتصال مستقیم',
    'status.direct.detail': 'هیچ درخواستی از پروکسی عبور نمیکند.',
    'status.manual.title': 'پروکسی دستی',
    'status.manual.detail': '{name} · {scheme}://{host}:{port}',
    'status.pac.title': 'اسکریپت PAC',
    'status.pac.detail': '{url}',
    'status.warnProfile.title': 'سروری انتخاب نشده',
    'status.warnProfile.detail': 'از پایین یک سرور انتخاب کنید؛ تا آن زمان ترافیک مستقیم است.',
    'status.warnPac.title': 'نشانی PAC خالی است',
    'status.warnPac.detail': 'نشانی PAC را وارد کنید؛ تا آن زمان ترافیک مستقیم است.',

    'profiles.title': 'سرورها',
    'profiles.add': 'افزودن سرور',
    'profiles.new': 'سرور جدید',
    'profiles.edit': 'ویرایش سرور',
    'profiles.empty': 'هنوز سروری ندارید. یکی اضافه کنید تا با یک کلیک جابهجا شوید.',
    'profiles.use': 'استفاده از این سرور',
    'profiles.editAction': 'ویرایش',
    'profiles.deleteAction': 'حذف',

    'field.name': 'نام',
    'field.namePlaceholder': 'مثلاً پروکسی خانه',
    'field.scheme': 'نوع',
    'field.port': 'پورت',
    'field.host': 'میزبان',
    'field.hostPlaceholder': '‎127.0.0.1 یا proxy.example.com',
    'field.username': 'نام کاربری',
    'field.password': 'گذرواژه',
    'field.authNote': 'نام کاربری و گذرواژه فقط روی همین دستگاه ذخیره میشود و هرگز همگامسازی نمیشود.',
    'field.pacUrl': 'نشانی اسکریپت PAC',
    'field.pacPlaceholder': 'https://example.com/proxy.pac',
    'field.pacHint': 'کروم این فایل PAC را دانلود میکند و طبق آن عمل میکند.',
    'field.bypass': 'فهرست عبور',
    'field.bypassPlaceholder': '<local>\nlocalhost\n127.0.0.1\n*.internal.example.com',
    'field.bypassSummary': '{count} قاعدهٔ عبور',
    'field.bypassNone': 'بدون قاعدهٔ عبور',

    'btn.save': 'ذخیره',
    'btn.cancel': 'انصراف',
    'btn.export': 'خروجی گرفتن',
    'btn.import': 'ورود از فایل',
    'btn.reset': 'بازنشانی',

    'msg.saved': 'ذخیره شد.',
    'msg.imported': 'تنظیمات وارد شد.',
    'msg.exported': 'فایل خروجی ساخته شد.',
    'msg.importError': 'این فایل قابل خواندن نبود.',
    'msg.resetDone': 'همهچیز به حالت پیشفرض برگشت.',

    'confirm.deleteProfile': 'این سرور حذف شود؟',
    'confirm.reset': 'همهٔ تنظیمات و سرورها به حالت پیشفرض برگردند؟',

    'error.nameRequired': 'نام را وارد کنید.',
    'error.nameDuplicate': 'سرور دیگری همین نام را دارد.',
    'error.hostRequired': 'میزبان را وارد کنید.',
    'error.hostInvalid': 'این میزبان معتبر نیست.',
    'error.portRequired': 'پورت را وارد کنید.',
    'error.portInvalid': 'پورت باید عدد باشد.',
    'error.portRange': 'پورت باید بین ۱ تا ۶۵۵۳۵ باشد.',
    'error.pacInvalid': 'نشانی PAC باید با http:// یا https:// شروع شود.',
    'error.importFormat': 'این فایل مربوط به پروکسی سوئیچ نیست.',
    'error.importJson': 'این فایل JSON معتبر نیست.',

    'options.title': 'تنظیمات پروکسی سوئیچ',
    'options.general': 'عمومی',
    'options.language': 'زبان',
    'options.languageAuto': 'خودکار (زبان مرورگر)',
    'options.enabled': 'امکان جابهجایی پروکسی فعال باشد',
    'options.auth': 'ارسال خودکار نام کاربری و گذرواژه',
    'options.authHint': 'به درخواست ورود سرور فعال، خودکار پاسخ میدهد تا کروم دوباره نپرسد.',
    'options.mode': 'حالت پروکسی',
    'options.servers': 'سرورها',
    'options.serversHint': 'روی هر سرور بزنید تا همان لحظه فعال شود.',
    'options.bypass': 'فهرست عبور',
    'options.bypassHint':
      'هر خط یک قاعده است. برای میزبانهای داخلی از <local> و برای الگوهایی مثل *.example.com استفاده کنید.',
    'options.data': 'پشتیبانگیری و بازنشانی',
    'options.dataHint':
      'فایل خروجی شامل نام کاربری و گذرواژه بهصورت متن ساده است؛ آن را جای امنی نگه دارید.',
    'options.about': 'درباره',
    'options.version': 'نسخه',
    'options.permissions': 'این افزونه فقط به چیزهایی نیاز دارد که لازم دارد:',
    'options.perm.proxy': 'proxy — تغییر تنظیمات پروکسی مرورگر',
    'options.perm.storage': 'storage — نگهداشتن سرورها و تنظیمات روی همین دستگاه',
    'options.perm.webRequest': 'webRequest — پاسخ به درخواست احراز هویت پروکسی با اطلاعات ذخیرهشده',
    'options.perm.host': 'دسترسی به همهٔ سایتها — برای مسیردهی ترافیک و احراز هویت پروکسی',

    'menu.root': 'پروکسی سوئیچ',
    'menu.direct': 'مستقیم (بدون پروکسی)',
    'menu.system': 'پروکسی سیستمی',
    'menu.settings': 'تنظیمات…',
  },
};

/** Keys present in one language but missing in another (used by the tests). */
export function missingKeys() {
  const result = {};
  for (const lang of SUPPORTED_LANGS) {
    const other = lang === 'en' ? 'fa' : 'en';
    result[lang] = Object.keys(MESSAGES[lang]).filter((key) => !(key in MESSAGES[other]));
  }
  return result;
}

/**
 * Looks a key up and fills `{placeholder}` tokens from `params`.
 * Unknown keys fall back to English first and then to the key itself, so a
 * missing translation shows up as an obvious marker instead of a blank label.
 */
export function t(key, lang = DEFAULT_LANG, params) {
  const dict = MESSAGES[lang] ?? MESSAGES[DEFAULT_LANG];
  let value = dict[key];
  if (value === undefined) value = MESSAGES[DEFAULT_LANG][key];
  if (value === undefined) return key;
  if (params) {
    value = value.replace(/\{(\w+)\}/g, (match, name) =>
      name in params ? String(params[name]) : match,
    );
  }
  return value;
}

/** Resolves the "auto" setting against a BCP-47 tag such as `navigator.language`. */
export function resolveLang(setting, browserLanguage) {
  if (SUPPORTED_LANGS.includes(setting)) return setting;
  return String(browserLanguage ?? '').toLowerCase().startsWith('fa') ? 'fa' : DEFAULT_LANG;
}

export function otherLang(lang) {
  return lang === 'fa' ? 'en' : 'fa';
}

export function isRtl(lang) {
  return lang === 'fa';
}

/**
 * Fills every `data-i18n*` element in `root`.
 * Supported attributes: `data-i18n`, `data-i18n-title`, `data-i18n-placeholder`,
 * `data-i18n-aria-label`.
 */
export function applyStaticText(root, lang) {
  if (!root?.querySelectorAll) return;
  const targets = [
    ['data-i18n', null],
    ['data-i18n-title', 'title'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-aria-label', 'aria-label'],
  ];
  for (const [dataAttribute, attribute] of targets) {
    for (const element of root.querySelectorAll(`[${dataAttribute}]`)) {
      const value = t(element.getAttribute(dataAttribute), lang);
      if (attribute) element.setAttribute(attribute, value);
      else element.textContent = value;
    }
  }
}

/** Sets `lang`/`dir` on <html> so RTL languages lay out correctly. */
export function applyDocumentLang(lang, doc = globalThis.document) {
  if (!doc?.documentElement) return;
  doc.documentElement.lang = lang;
  doc.documentElement.dir = isRtl(lang) ? 'rtl' : 'ltr';
}

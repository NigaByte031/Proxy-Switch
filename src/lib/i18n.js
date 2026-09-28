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
    'action.masterToggle': 'Turn the proxy on or off',
    'lang.switch': 'Switch language',
    'theme.switch': 'Switch theme',
    'theme.auto': 'Automatic',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'accent.title': 'Accent colour',
    'accent.emerald': 'Emerald',
    'accent.ocean': 'Ocean',
    'accent.violet': 'Violet',
    'accent.amber': 'Amber',
    'accent.rose': 'Rose',

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
    'status.pacDomains.title': 'Selected sites are routed',
    'status.pacDomains.detail': '{name} · {count} listed site(s)',
    'status.warnProfile.title': 'No server selected',
    'status.warnProfile.detail': 'Pick a server below — until then traffic stays direct.',
    'status.warnPac.title': 'PAC URL is empty',
    'status.warnPac.detail': 'Add a PAC URL — until then traffic stays direct.',
    'status.warnDomains.title': 'No sites are listed',
    'status.warnDomains.detail': 'Add at least one domain, or switch the list off — until then traffic stays direct.',
    'status.applyFailed.title': 'The proxy could not be changed',
    'status.applyFailed.detail': 'Chrome refused the change: {reason}',
    'status.notInControl.title': 'Another program is controlling the proxy',
    'status.notInControl.detail':
      'Your browser, a policy or another extension owns the proxy settings, so this mode is not applied ({level}).',

    'popup.shortcuts': 'Alt+Shift+P on/off · Alt+Shift+D direct',

    'health.action': 'Test connection',
    'health.running': 'Testing…',
    'health.ok.title': 'Connection works',
    'health.ok.detail': '{host} answered in {ms}',
    'health.serverOk': 'answered in {ms}',
    'health.serverFail': 'no answer',
    'health.serverAge.now': 'just now',
    'health.serverAge.minutes': '{count} min ago',
    'health.serverAge.hours': '{count} h ago',
    'health.serverAge.days': '{count} d ago',
    'health.fail.title': 'No connection',
    'health.fail.detail':
      'Nothing answered through the current mode — check the server or your network.',

    'health.testAll.action': 'Test all',
    'health.testAll.running': 'Testing all…',
    'health.testAll.progress': '{done} of {total} tested…',
    'health.testAll.summary': '{ok} worked · {failed} no answer · {skipped} skipped',
    'health.testAll.busy': 'A test is already running.',
    'health.testAll.notEligible':
      'Servers cannot be tested in the current mode — switch to Manual or domain routing first.',
    'health.testAll.empty': 'There is no server to test.',

    'traffic.title': 'Traffic',
    'traffic.today': 'Today',
    'traffic.total': 'Total',
    'traffic.rightNow': 'Right now',
    'traffic.rate': '↓ {down} · ↑ {up}',
    'traffic.rateIdle': 'nothing moving',
    'traffic.rateIdleHint': 'No bytes have been counted in the last few seconds — a burst that just ended is not a speed.',
    'traffic.down': 'Downloaded {value}',
    'traffic.up': 'Uploaded {value}',
    'traffic.totalTitle': 'Counted so far: ↓ {down} · ↑ {up}',
    'traffic.note':
      'Counted from the size each request and response declares before its bytes move, so it is a floor rather than a bill: a streamed video, an event stream or a chunked page declares nothing and is not counted, and a response Chrome answers out of its own cache is not counted at all. Only traffic while the proxy is on is counted.',
    'traffic.enable': 'Count traffic',
    'traffic.enableHint':
      'The counting happens here, on this device: nothing is sent anywhere, and the counters are not part of an exported settings file. Switching it off stops the counting — the numbers already there stay until you reset them.',
    'traffic.reset': 'Reset counters',
    'traffic.confirmReset': 'Reset the traffic counters to zero?',
    'traffic.resetDone': 'Counters reset.',

    'profiles.title': 'Servers',
    'profiles.add': 'Add server',
    'profiles.new': 'New server',
    'profiles.edit': 'Edit server',
    'profiles.empty': 'No servers yet. Add one to switch proxies in a click.',
    'profiles.use': 'Use this server',
    'profiles.editAction': 'Edit',
    'profiles.deleteAction': 'Delete',
    'profiles.search': 'Search servers',
    'profiles.searchHint': 'Type to narrow the list down — press / anywhere to jump here.',
    'profiles.searchClear': 'Clear search',
    'profiles.noMatch': 'No server matches “{query}”.',
    'profiles.confirmDelete': 'Delete “{name}”?',

    'field.name': 'Name',
    'field.namePlaceholder': 'e.g. Home proxy',
    'field.scheme': 'Type',
    'field.port': 'Port',
    'field.host': 'Host',
    'field.hostPlaceholder': '127.0.0.1 or proxy.example.com',
    'field.pasteHint':
      'Paste a whole proxy URL — socks5://user:pass@127.0.0.1:1080 — and the fields fill themselves.',
    'field.username': 'Username',
    'field.password': 'Password',
    'field.authNote': 'Credentials stay on this device only and are never synced.',
    'field.pacUrl': 'PAC script URL',
    'field.pacPlaceholder': 'https://example.com/proxy.pac',
    'field.pacHint': 'Chrome downloads this proxy auto-config file and obeys it.',
    'field.domainRouting': 'Route only the sites I list',
    'field.domainRoutingHint':
      'Instead of downloading a PAC file, one is built from your own list: those sites use your servers — the active one first, the others as fallback, with a server that recently answered ahead of one nobody has looked at — while everything else stays direct. A listed site is never sent direct, so a server that is down fails loudly instead of leaking it.',
    'field.domainList': 'Sites that use the proxy',
    'field.domainListPlaceholder':
      '# one per line\nexample.com\n*.internal.example.com\nlocalhost',
    'field.domainListHint':
      'A domain covers itself and its subdomains; *.domain covers the subdomains only, and * or ? work as patterns. Use <local> for dot-less intranet names. Leave a rule out and its traffic stays direct. Bypass rules above still win.',
    'field.bypass': 'Bypass list',
    'field.bypassPlaceholder': '<local>\nlocalhost\n127.0.0.1\n*.internal.example.com',
    'field.bypassSummary': '{count} bypass rules',
    'field.bypassNone': 'No bypass rules',

    'apply.retry': 'Try again',
    'apply.retrying': 'Applying…',

    'btn.save': 'Save',
    'btn.cancel': 'Cancel',
    'btn.export': 'Export',
    'btn.import': 'Import',
    'btn.reset': 'Reset',

    'msg.applied': 'The proxy settings were applied.',
    'msg.applyFailed': 'Chrome did not apply the settings — the reason is above.',
    'msg.saved': 'Saved.',
    'msg.imported': 'Settings imported.',
    'msg.exported': 'Settings exported.',
    'msg.importError': 'That file could not be imported.',
    'msg.resetDone': 'Everything was reset to defaults.',

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
    'options.theme': 'Theme',
    'options.themeAuto': 'Automatic (system theme)',
    'options.enabled': 'Proxy switching enabled',
    'options.auth': 'Send proxy credentials automatically',
    'options.authHint':
      'Answers the login prompt of your active server so Chrome stops asking for it.',
    'options.failover': 'Switch to another server when the active one stops answering',
    'options.failoverHint':
      'Manual mode with two servers or more: after a few failed requests the connection is checked once more, and only a server that really is down is replaced — by the healthiest other one, meaning the fastest server that recently answered, and never one that just failed. One round visits every other server once and then stops, so a network outage cannot make the extension flip back and forth.',
    'options.notifyFailover': 'Tell me when the extension switches servers on its own',
    'options.notifyFailoverHint':
      'A system notification names the server that took over, and the toolbar icon briefly wears its name. Only automatic switches are reported — picking a server yourself is an answer, not news.',
    'options.backgroundProbe': 'Check my servers in the background',
    'options.backgroundProbeHint':
      'While the extension is routing traffic it looks at one server every few minutes, so what it knows about each of them stays recent and the fallback chain of a generated PAC script stays in the order that actually works. A check hands only the extension\'s own probe request to the server it is testing — your browsing keeps the routing you configured, and nothing about it goes anywhere new. Off by default: it is the one thing here that uses the network on its own.',
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
      'webRequest — answer proxy authentication prompts with your saved credentials, and measure traffic sizes for the meter',
    'options.perm.notifications':
      'notifications — show a system notification when the extension switches servers by itself',
    'options.perm.alarms':
      'alarms — the timer behind the periodic background check, which is only set while that setting is on',
    'options.perm.host': 'all sites — required to route traffic and authenticate the proxy',
    'options.shortcuts':
      'Shortcuts: Alt+Shift+P turns the proxy on or off, Alt+Shift+D goes direct. Change them on chrome://extensions/shortcuts.',

    'menu.root': 'Proxy Switch',
    'menu.direct': 'Direct (no proxy)',
    'menu.system': 'System proxy',
    'menu.settings': 'Settings…',

    'notice.switched.title': 'Server changed',
    'notice.switched.message':
      'The active server stopped answering, so {name} is now in use.',
    'badge.switched': 'switched to {name}',
    'notice.switched.button': 'Back to {name}',
  },

  fa: {
    'app.name': 'پروکسی سوئیچ',
    'app.tagline': 'کنترل پروکسی کروم با یک کلیک',
    'action.settings': 'تنظیمات',
    'action.masterToggle': 'روشن یا خاموش کردن پروکسی',
    'lang.switch': 'تغییر زبان',
    'theme.switch': 'تغییر تم',
    'theme.auto': 'خودکار',
    'theme.light': 'روشن',
    'theme.dark': 'تیره',
    'accent.title': 'رنگ اصلی',
    'accent.emerald': 'زمردی',
    'accent.ocean': 'اقیانوسی',
    'accent.violet': 'بنفش',
    'accent.amber': 'کهربایی',
    'accent.rose': 'سرخابی',

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
    'status.pacDomains.title': 'فقط سایت‌های انتخابی از پروکسی می‌روند',
    'status.pacDomains.detail': '{name} · {count} سایت فهرست‌شده',
    'status.warnProfile.title': 'سروری انتخاب نشده',
    'status.warnProfile.detail': 'از پایین یک سرور انتخاب کنید؛ تا آن زمان ترافیک مستقیم است.',
    'status.warnPac.title': 'نشانی PAC خالی است',
    'status.warnPac.detail': 'نشانی PAC را وارد کنید؛ تا آن زمان ترافیک مستقیم است.',
    'status.warnDomains.title': 'هیچ سایتی فهرست نشده',
    'status.warnDomains.detail': 'دست‌کم یک دامنه اضافه کنید یا این فهرست را خاموش کنید؛ تا آن زمان ترافیک مستقیم است.',
    'status.applyFailed.title': 'پروکسی تغییر نکرد',
    'status.applyFailed.detail': 'کروم این تغییر را نپذیرفت: {reason}',
    'status.notInControl.title': 'برنامهٔ دیگری پروکسی را کنترل می‌کند',
    'status.notInControl.detail':
      'تنظیمات پروکسی در اختیار مرورگر، یک سیاست سازمانی یا افزونهٔ دیگری است؛ بنابراین این حالت اعمال نشده است ({level}).',

    'popup.shortcuts': 'Alt+Shift+P روشن/خاموش · Alt+Shift+D مستقیم',

    'health.action': 'تست اتصال',
    'health.running': 'در حال تست…',
    'health.ok.title': 'اتصال برقرار است',
    'health.ok.detail': '{host} در {ms} پاسخ داد',
    'health.serverOk': 'پاسخ در {ms}',
    'health.serverFail': 'بدون پاسخ',
    'health.serverAge.now': 'همین حالا',
    'health.serverAge.minutes': '{count} دقیقه پیش',
    'health.serverAge.hours': '{count} ساعت پیش',
    'health.serverAge.days': '{count} روز پیش',
    'health.fail.title': 'اتصال برقرار نشد',
    'health.fail.detail': 'در حالت فعلی پاسخی نرسید — سرور یا شبکه را بررسی کنید.',

    'health.testAll.action': 'تست همه',
    'health.testAll.running': 'در حال تست همه…',
    'health.testAll.progress': '{done} از {total} آزموده شد…',
    'health.testAll.summary': '{ok} جواب داد · {failed} بی‌پاسخ · {skipped} رد شد',
    'health.testAll.busy': 'یک آزمایش از قبل در جریان است.',
    'health.testAll.notEligible':
      'در حالت فعلی امکان آزمایش سرورها نیست — اول حالت دستی یا مسیردهی دامنه‌ها را انتخاب کنید.',
    'health.testAll.empty': 'سروری برای آزمایش وجود ندارد.',

    'traffic.title': 'ترافیک',
    'traffic.today': 'امروز',
    'traffic.total': 'مجموع',
    'traffic.rightNow': 'همین حالا',
    'traffic.rate': '↓ {down} · ↑ {up}',
    'traffic.rateIdle': 'چیزی در جریان نیست',
    'traffic.rateIdleHint': 'چند ثانیهٔ اخیر بایتی شمرده نشده — انفجاری که تازه تمام شده، سرعت نیست.',
    'traffic.down': 'دانلود {value}',
    'traffic.up': 'آپلود {value}',
    'traffic.totalTitle': 'آنچه تا اینجا شمرده شده: ↓ {down} · ↑ {up}',
    'traffic.note':
      'از روی اندازهٔ اعلام‌شدهٔ هر درخواست و پاسخ شمرده می‌شود، پیش از آنکه بایت‌هایش جابه‌جا شوند؛ پس عددها یک کف هستند و نه صورت‌حساب: ویدئوی استریم، جریان رویداد و صفحهٔ تکه‌تکه‌ای (chunked) چیزی اعلام نمی‌کنند و شمرده نمی‌شوند، و پاسخی که کروم از کش خودش می‌دهد به‌کل شمرده نمی‌شود. فقط ترافیک زمانِ روشن‌بودن پروکسی شمرده می‌شود.',
    'traffic.enable': 'شمارش ترافیک',
    'traffic.enableHint':
      'شمارش همین‌جا و روی همین دستگاه انجام می‌شود: چیزی به جایی فرستاده نمی‌شود و این شمارنده‌ها در فایل پشتیبان تنظیمات نمی‌آیند. خاموش‌کردنش شمارش را متوقف می‌کند — عددهای موجود تا وقتی خودتان صفرشان نکنید می‌مانند.',
    'traffic.reset': 'صفر کردن شمارنده‌ها',
    'traffic.confirmReset': 'شمارنده‌های ترافیک صفر شوند؟',
    'traffic.resetDone': 'شمارنده‌ها صفر شدند.',

    'profiles.title': 'سرورها',
    'profiles.add': 'افزودن سرور',
    'profiles.new': 'سرور جدید',
    'profiles.edit': 'ویرایش سرور',
    'profiles.empty': 'هنوز سروری ندارید. یکی اضافه کنید تا با یک کلیک جابهجا شوید.',
    'profiles.use': 'استفاده از این سرور',
    'profiles.editAction': 'ویرایش',
    'profiles.deleteAction': 'حذف',
    'profiles.search': 'جست‌وجوی سرورها',
    'profiles.searchHint': 'برای کوتاه‌شدن فهرست تایپ کنید — کلید / از هر جا نشانگر را اینجا می‌آورد.',
    'profiles.searchClear': 'پاک کردن جست‌وجو',
    'profiles.noMatch': 'هیچ سروری با «{query}» پیدا نشد.',
    'profiles.confirmDelete': '«{name}» حذف شود؟',

    'field.name': 'نام',
    'field.namePlaceholder': 'مثلاً پروکسی خانه',
    'field.scheme': 'نوع',
    'field.port': 'پورت',
    'field.host': 'میزبان',
    'field.hostPlaceholder': '‎127.0.0.1 یا proxy.example.com',
    'field.username': 'نام کاربری',
    'field.password': 'گذرواژه',
    'field.authNote': 'نام کاربری و گذرواژه فقط روی همین دستگاه ذخیره میشود و هرگز همگامسازی نمیشود.',
    'field.domainRouting': 'فقط سایت‌هایی که فهرست می‌کنم از پروکسی بروند',
    'field.domainRoutingHint':
      'به‌جای دانلود فایل PAC، از فهرست خودتان یکی ساخته می‌شود: آن سایت‌ها از سرورهای شما می‌روند — اول سرور فعال و بعدی‌ها به‌عنوان پشتیبان، و سروری که تازه جواب داده جلوتر از سروری می‌آید که هنوز آزمایش نشده — و بقیه مستقیم می‌مانند. سایتِ فهرست‌شده هیچ‌وقت مستقیم فرستاده نمی‌شود، پس سرور قطع‌شده پیام خطا می‌دهد و ترافیک را بی‌صدا لو نمی‌دهد.',
    'field.domainList': 'سایت‌هایی که از پروکسی می‌روند',
    'field.domainListPlaceholder':
      '# هر خط یک قاعده\nexample.com\n*.internal.example.com\nlocalhost',
    'field.domainListHint':
      'یک دامنه، خودش و زیردامنه‌هایش را می‌گیرد؛ *.domain فقط زیردامنه‌ها را، و * و ? به‌عنوان الگو کار می‌کنند. برای نام‌های داخلی بدون نقطه از <local> استفاده کنید. هر چیزی که در فهرست نباشد مستقیم می‌رود. قواعد عبور بالا هنوز مقدم‌اند.',
    'field.pacUrl': 'نشانی اسکریپت PAC',
    'field.pacPlaceholder': 'https://example.com/proxy.pac',
    'field.pacHint': 'کروم این فایل PAC را دانلود میکند و طبق آن عمل میکند.',
    'field.pasteHint':
      'یک نشانی کامل پروکسی را جای‌گذاری کنید — مثل socks5://user:pass@127.0.0.1:1080 — تا فیلدها خودکار پر شوند.',
    'field.bypass': 'فهرست عبور',
    'field.bypassPlaceholder': '<local>\nlocalhost\n127.0.0.1\n*.internal.example.com',
    'field.bypassSummary': '{count} قاعدهٔ عبور',
    'field.bypassNone': 'بدون قاعدهٔ عبور',

    'apply.retry': 'تلاش دوباره',
    'apply.retrying': 'در حال اعمال…',

    'btn.save': 'ذخیره',
    'btn.cancel': 'انصراف',
    'btn.export': 'خروجی گرفتن',
    'btn.import': 'ورود از فایل',
    'btn.reset': 'بازنشانی',

    'msg.applied': 'تنظیمات پروکسی اعمال شد.',
    'msg.applyFailed': 'کروم تنظیمات را اعمال نکرد — دلیلش بالا آمده است.',
    'msg.saved': 'ذخیره شد.',
    'msg.imported': 'تنظیمات وارد شد.',
    'msg.exported': 'فایل خروجی ساخته شد.',
    'msg.importError': 'این فایل قابل خواندن نبود.',
    'msg.resetDone': 'همهچیز به حالت پیشفرض برگشت.',

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
    'options.theme': 'تم',
    'options.themeAuto': 'خودکار (تم سیستم)',
    'options.enabled': 'امکان جابهجایی پروکسی فعال باشد',
    'options.auth': 'ارسال خودکار نام کاربری و گذرواژه',
    'options.authHint': 'به درخواست ورود سرور فعال، خودکار پاسخ میدهد تا کروم دوباره نپرسد.',
    'options.failover': 'هنگام بی‌پاسخ ماندن سرور فعال، خودکار به سرور دیگری سوئیچ شود',
    'options.failoverHint':
      'در حالت دستی و با دست‌کم دو سرور: بعد از چند درخواست ناموفق، اتصال یک بار دیگر بررسی می‌شود و فقط سروری که واقعاً قطع است با سرور بعدیِ فهرست عوض می‌شود. در هر نوبت یک‌بار از همهٔ سرورها رد می‌شویم و بعد متوقف می‌شویم تا قطعی شبکه باعث جابهجایی پیوسته نشود.',
    'options.notifyFailover': 'وقتی افزونه خودش سرور را عوض می‌کند به من اطلاع بده',
    'options.notifyFailoverHint':
      'یک اعلان سیستمی نام سروری را که جایگزین شده می‌گوید و آیکون افزونه هم چند لحظه همان نام را نشان می‌دهد. فقط سوئیچ‌های خودکار گزارش می‌شوند — انتخاب دستی سرور خودِ پاسخ است، نه خبر تازه.',
    'options.backgroundProbe': 'سرورها را در پس‌زمینه بررسی کن',
    'options.backgroundProbeHint':
      'تا وقتی افزونه ترافیک را مسیردهی می‌کند، هر چند دقیقه یک سرور را نگاه می‌کند تا دانسته‌هایش دربارهٔ هر سرور تازه بماند و زنجیرهٔ پشتیبان اسکریپت PAC تولیدشده به همان ترتیبی بماند که واقعاً کار می‌کند. هر بررسی فقط درخواست کاوش خودِ افزونه را به سروری می‌دهد که آزمایش می‌شود — گشت‌وگذار شما همان مسیردهی تنظیم‌شده را نگه می‌دارد و چیزی از آن به جای تازه‌ای نمی‌رود. پیش‌فرض خاموش است: تنها گزینه‌ای است که خودش از شبکه استفاده می‌کند.',
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
    'options.perm.webRequest':
      'webRequest — پاسخ به درخواست احراز هویت پروکسی با اطلاعات ذخیره‌شده، و اندازه‌گیری اندازهٔ ترافیک برای شمارنده',
    'options.perm.notifications':
      'notifications — نمایش اعلان سیستمی وقتی افزونه خودش سرور را عوض می‌کند',
    'options.perm.alarms':
      'alarms — زمان‌سنج بررسی دوره‌ای پس‌زمینه، که فقط وقتی آن گزینه روشن باشد تنظیم می‌شود',
    'options.perm.host': 'دسترسی به همهٔ سایتها — برای مسیردهی ترافیک و احراز هویت پروکسی',
    'options.shortcuts':
      'میان‌برهای صفحه‌کلید: Alt+Shift+P پروکسی را روشن/خاموش می‌کند و Alt+Shift+D اتصال را مستقیم می‌کند. تغییر آن‌ها در chrome://extensions/shortcuts.',

    'menu.root': 'پروکسی سوئیچ',
    'menu.direct': 'مستقیم (بدون پروکسی)',
    'menu.system': 'پروکسی سیستمی',
    'menu.settings': 'تنظیمات…',

    'notice.switched.title': 'سرور عوض شد',
    'notice.switched.message': 'سرور فعال پاسخ نداد؛ از این پس از «{name}» استفاده می‌شود.',
    'badge.switched': 'سوئیچ به «{name}»',
    'notice.switched.button': 'بازگشت به «{name}»',
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

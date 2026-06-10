const fs = require('fs');
const path = require('path');

const SOURCE_HTML = path.join(__dirname, 'space_arena_v2.html');
const OUTPUT_JSON = path.join(__dirname, 'wp_space_arena_publish.json');
const WS_URL = process.env.SPACE_ARENA_WS_URL || '';

const shellCss = [
  'html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:#000!important;height:100%!important;width:100%!important}',
  'body .wp-site-blocks > header,body .wp-site-blocks > footer{display:none!important}',
  'body .wp-site-blocks,body main,body .entry-content,body .wp-block-post-content,body .is-layout-constrained{margin:0!important;padding:0!important;max-width:none!important;width:100%!important}',
  'body main{display:block!important}',
  '#wrap{position:fixed!important;inset:0!important;left:0!important;right:0!important;top:0!important;bottom:0!important;width:100vw!important;height:100vh!important;max-width:none!important;margin:0!important;z-index:9999!important}',
  '#ui{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important}',
  'canvas#c{width:100vw!important;height:100vh!important;display:block!important}',
  'body.admin-bar #wrap{top:32px!important;height:calc(100vh - 32px)!important}',
  '@media (max-width:782px){body.admin-bar #wrap{top:46px!important;height:calc(100vh - 46px)!important}}',
].join('\n');

const replacements = new Map([
  ['—', '-'], ['–', '-'], ['·', '-'], ['•', '-'],
  ['⚡', 'ALT'], ['🌩', 'ARC'], ['⛽', 'FUEL'], ['💎', 'GEMS'],
  ['🌍', 'PLANETS'], ['⭐', 'STAR'], ['★', 'ARMY'], ['△', 'TRI'],
  ['□', 'BOX'], ['⏸', 'PAUSE'], ['⌨', 'KEYS'], ['🌐', 'POLITICS'],
  ['🏆', 'LEADERBOARD'], ['💣', 'MINES'], ['🚀', 'MISSILES'], ['⚫', 'BH'],
  ['⚙', 'UPGRADES'], ['⠿', 'drag'], ['📋', 'MISSION'], ['✅', 'ACCEPT'],
  ['❌', 'CLOSE'], ['💰', 'TRADE'], ['🛡', 'DEFENSE'], ['⇧', 'SHIFT+'],
  ['▶', 'RESUME'], ['⟳', 'RESET'], ['📖', 'RECIPES'], ['🔧', 'SETTINGS'],
  ['🖥', 'DISPLAY'], ['⚔', 'ATTACK'], ['💾', 'SAVE'], ['🛸', 'SUPPORT'],
  ['☢', 'NUKE'], ['🔊', 'SOUND'], ['🔇', 'MUTE'], ['─', '-'],
  ['🟫', 'BROWN'], ['⬛', 'DARK'], ['🔵', 'BLUE'], ['🟩', 'GREEN'],
  ['🟣', 'PURPLE'], ['🩵', 'CYAN'], ['🌌', 'SPACE'], ['👻', 'GHOST'],
  ['💫', 'SPIN'], ['×', 'x'], ['🌀', 'WORM'], ['🔓', 'OPEN'],
  ['❤', 'HP'], ['🔫', 'DMG'], ['🎯', 'AIM'], ['⏱', 'TIME'],
  ['💨', 'BOOST'], ['📦', 'CRATE'], ['🛰', 'SAT'], ['🚚', 'MOVE'],
  ['💥', 'BLAST'], ['🌟', 'STAR'], ['☀', 'SUN'], ['🌱', 'GROW'],
  ['🗑', 'DELETE'], ['°', ' deg'], ['🪖', 'WAR'], ['🔭', 'SCAN'],
  ['👑', 'CROWN'], ['💢', 'ANGER'], ['🕊', 'PEACE'], ['✦', '*'],
  ['🥇', '#1'], ['🥈', '#2'], ['🥉', '#3'], ['✝', '+'],
  ['🔒', 'LOCKED'], ['→', '->'], ['🔸', '>'], ['🔴', 'RED'],
  ['🟤', 'BROWN'], ['🟢', 'GREEN'], ['✓', 'OK'], ['⚒', 'CRAFT'],
  ['⏳', 'WAIT'], ['●', 'O'], ['▮', '|'], ['▯', '[]'], ['🤝', 'ALLY'],
  ['💀', 'SKULL'], ['☠', 'PIRATE'], ['✨', 'SPARK'], ['◀', '<'],
  ['🎉', 'WIN'], ['☄', 'COMET'], ['💠', 'NODE'], ['🕳', 'VOID'],
  ['👥', 'PLAYERS'], ['📏', 'SIZE'], ['🏴', 'FLAG'], ['⚠', 'WARN'],
  ['⭕', 'CIRCLE'], ['⚪', 'WHITE'], ['🎖', 'MEDAL'], ['↔', '<->'],
  ['≈', '~'], ['🔍', 'SCAN'], ['🪨', 'ROCK'], ['⚱', 'URN'],
  ['∅', 'NONE'], ['❗', '!'], ['🧪', 'LAB'], ['️', '']
]);

function sanitizeAscii(input) {
  let text = input;
  for (const [from, to] of replacements) text = text.split(from).join(to);
  text = text.replace(/[^\x00-\x7F]/g, '');
  text = text.replace(/\s+\|\s+\[/g, ' | [');
  return text;
}

function extractBlock(html, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(re);
  if (!match) throw new Error(`Could not find <${tag}> block in source HTML`);
  return match[1];
}

function main() {
  const source = fs.readFileSync(SOURCE_HTML, 'utf8');
  const styleCss = extractBlock(source, 'style');
  const bodyMatch = source.match(/<body>([\s\S]*?)<script>[\s\S]*<\/script>\s*<\/body>/i);
  const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>\s*<\/body>\s*<\/html>\s*$/i);
  if (!bodyMatch || !scriptMatch) throw new Error('Could not extract body/script from source HTML');

  let bodyHtml = bodyMatch[1];
  let gameJs = scriptMatch[1];

  // Hide the manual multiplayer panel on the homepage.
  bodyHtml = bodyHtml.replace(/\s*<div id="mpbox">[\s\S]*?<\/div>\s*(<div id="btnrow">)/, '\n$1');

  bodyHtml = sanitizeAscii(bodyHtml);
  gameJs = sanitizeAscii(gameJs);

  const encodedJs = Buffer.from(gameJs, 'utf8').toString('base64');
  const config = { room: 'main', autoConnect: true };
  if (WS_URL) config.wsUrl = WS_URL;

  const payload = {
    title: 'Space Arena',
    slug: 'space-arena',
    status: 'publish',
    content: [
      '<!-- wp:html -->',
      `<style>\n${shellCss}\n</style>`,
      `<style>\n${styleCss}\n</style>`,
      `<script>window.SPACE_ARENA_CONFIG=window.SPACE_ARENA_CONFIG||${JSON.stringify(config)};</script>`,
      bodyHtml.trim(),
      `<script>(function(){var s=atob('${encodedJs}');var n=document.createElement('script');n.text=s;document.body.appendChild(n);}())</script>`,
      '<!-- /wp:html -->'
    ].join('\n')
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(payload), 'utf8');
  const remaining = [...new Set(payload.content.match(/[^\x00-\x7F]/g) || [])];
  console.log(JSON.stringify({
    output: path.basename(OUTPUT_JSON),
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    wsUrl: config.wsUrl || '',
    remainingNonAscii: remaining
  }, null, 2));
}

main();

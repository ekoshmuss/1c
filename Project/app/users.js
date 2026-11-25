// Управление пользователями веб-интерфейса
//   node users.js add <логин> [admin|viewer] ["Имя Фамилия"]   — добавить / сменить пароль
//   node users.js list                                         — список
//   node users.js disable <логин> | enable <логин>              — заблокировать / разблокировать
//   node users.js remove <логин>                                — удалить
// Роли: admin — может задавать нормы запаса; viewer — только просмотр и отчёты.
'use strict';
const readline = require('readline');
const { readUsers, writeUsers, hashPassword } = require('./auth');

// Скрытый ввод (один интерфейс readline на оба вопроса — иначе в Windows второй вопрос получает пустую строку)
let rl = null;
function askHidden(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (rl._prompting) process.stdout.write(s); };
  }
  return new Promise((resolve) => {
    rl._prompting = true;
    rl.question(question, (answer) => { process.stdout.write('\n'); resolve(String(answer).replace(/\r/g, '')); });
    rl._prompting = false;
  });
}

(async () => {
  const [cmd, rawLogin, role = 'viewer', name] = process.argv.slice(2);
  const login = String(rawLogin || '').trim().toLowerCase();
  const users = readUsers();
  if (cmd === 'list') {
    const rows = Object.entries(users).map(([k, u]) => `${k.padEnd(20)} ${String(u.role).padEnd(7)} ${u.disabled ? 'ЗАБЛОКИРОВАН' : 'активен'}  ${u.name || ''}`);
    console.log(rows.length ? rows.join('\n') : 'Пользователей нет');
    return;
  }
  if (!login) { console.log('Укажите логин. Пример: node users.js add ivanova admin "Иванова А."'); process.exit(1); }
  if (cmd === 'add') {
    if (!['admin', 'viewer'].includes(role)) { console.log('Роль: admin или viewer'); process.exit(1); }
    const p1 = await askHidden(`Пароль для ${login}: `);
    if (p1.length < 8) { console.log('Пароль должен быть не короче 8 символов'); process.exit(1); }
    const p2 = await askHidden('Повторите пароль: ');
    if (p1 !== p2) { console.log('Пароли не совпадают. Запустите команду ещё раз.'); process.exit(1); }
    rl.close();
    users[login] = { ...hashPassword(p1), role, name: name || users[login]?.name || login, disabled: false };
    writeUsers(users);
    console.log(`Готово: ${login} (${role})`);
  } else if (cmd === 'remove') {
    delete users[login]; writeUsers(users); console.log('Удалён: ' + login);
  } else if (cmd === 'disable' || cmd === 'enable') {
    if (!users[login]) { console.log('Нет такого пользователя'); process.exit(1); }
    users[login].disabled = cmd === 'disable'; writeUsers(users); console.log(`${login}: ${cmd === 'disable' ? 'заблокирован' : 'разблокирован'}`);
  } else {
    console.log('Команды: add, list, disable, enable, remove');
  }
})();

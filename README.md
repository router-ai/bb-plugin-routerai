# bb-plugin-routerai

Плагин для [bb](https://getbb.app): провайдер **RouterAI**. Треды bb работают на моделях [routerai.ru](https://routerai.ru), агент — OpenCode, подключённый через ACP-бридж из SDK bb.

Репозиторий приватный, релизов нет; плагин ставится в bb из локального каталога.

## Как устроен

- `server.ts` — серверная часть: настройки, вход через RouterAI (OAuth PKCE), ключ как секрет, каталог моделей, регистрация провайдера `routerai`, команды `bb routerai`.
- `host.ts` — часть на машине с агентом: готовый ACP-бридж из `@get-bb/plugin-sdk` и запись ключа в закрытый файл (0600), откуда его читает OpenCode.
- `src/routerai/` — клиент API RouterAI, разбор каталога, OAuth.
- `src/opencode-config.ts` — конфиг OpenCode; передаётся агенту через `OPENCODE_CONFIG_CONTENT`, файлы OpenCode пользователя не затрагиваются.
- `src/spend-currency.ts` — расход треда в рублях: OpenCode считает сумму по рублёвым ценам из конфига, но подписывает её «USD»; мост в `host.ts` меняет подпись на RUB по пути в bb.
- `src/bridge-health.ts` — готовность провайдера: мост отвечает bb «не вошёл» / «ключ отклонён» по файлу ключа и метке рядом с ним. Сообщения в треды RouterAI без рабочего ключа останавливает хук `message.dispatch` в `server.ts` — с подсказкой, где войти.
- `test/` — тесты (vitest, фейковый хост из SDK).

Ключ RouterAI не попадает ни в опции провайдера, ни в окружение треда: сервер передаёт его на машину отдельным вызовом, а в конфиге стоит только ссылка на файл.

## Команды

```
bb routerai status [--json]          вход, баланс, лимит ключа, модели пикера
bb routerai login [--manual]         начать вход; --manual — код показывается на routerai.ru
bb routerai login --code <код|адрес> завершить вход вставкой кода
bb routerai logout
bb routerai models [--json]
bb routerai models search <текст>
bb routerai models set <slug>…       первая модель — по умолчанию
bb routerai models reset
```

## Разработка

Локальные тулчейны не нужны: всё выполняется в docker-стенде (лежит вне репозитория, `../bb-plugin-routerai-lab`).

```sh
cd ../bb-plugin-routerai-lab
docker compose up -d --build
docker compose exec bb npm install --include=dev --legacy-peer-deps
docker compose exec bb npx tsc --noEmit
docker compose exec bb npx vitest run
docker compose exec bb bb plugin install /plugins/routerai --yes   # один раз
docker compose exec bb bb plugin reload routerai                   # после правок
docker compose exec bb sh /lab/oauth-e2e.sh                        # сквозной вход через OAuth
```

Интерфейс bb: http://127.0.0.1:38886. Версия `@get-bb/plugin-sdk` должна совпадать с той, с которой работает bb стенда, иначе плагин помечается несовместимым.

## Лицензия

MIT, см. `LICENSE`. Базовые компоненты интерфейса (`components/ui/`, `lib/utils.ts`) взяты из штатного шаблона плагина bb (`bb plugin new`) — MIT, © Michael Yong, см. `LICENSE.bb-upstream`.

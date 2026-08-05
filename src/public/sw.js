/* Service Worker da plataforma — servido em /sw.js para valer em todas as rotas.

   Ele existe por um motivo só: mostrar as notificações fora do ciclo de vida de
   qualquer tela. Duas entradas chegam aqui:

     1. `push`    — mensagem do serviço de push do navegador. Funciona com a
                    plataforma fechada e é o único caminho no Android, onde
                    `new Notification()` na página não é permitido.
     2. `message` — a aba manda o aviso que recebeu pelo canal SSE. Serve para
                    quem não autorizou (ou não tem) push, mas está com a
                    plataforma aberta em alguma aba.

   Nada aqui depende da rota em que o usuário está. */

const ICONE = '/static/img/notificacao.svg';

self.addEventListener('install', () => {
  // Assume o comando sem esperar a aba antiga fechar.
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(self.clients.claim());
});

/** Notificação a partir da carga do aviso (mesmo formato no push e no SSE). */
function mostrar(aviso) {
  if (!aviso || !aviso.titulo) return Promise.resolve();
  return self.registration.showNotification(aviso.titulo, {
    body: aviso.mensagem || '',
    icon: ICONE,
    badge: ICONE,
    // A tag junta as repetições do mesmo aviso em vez de empilhar cópias.
    tag: `jsgrilo-aviso-${aviso.id || Date.now()}`,
    renotify: false,
    timestamp: aviso.criadoEm ? Date.parse(aviso.criadoEm) || Date.now() : Date.now(),
    data: { url: aviso.url || '/avisos', id: aviso.id || null },
    requireInteraction: aviso.tipo === 'impedido',
  });
}

self.addEventListener('push', (evento) => {
  let aviso = null;
  try {
    aviso = evento.data ? evento.data.json() : null;
  } catch (_) {
    aviso = { titulo: 'JS Grilo · Processos', mensagem: (evento.data && evento.data.text()) || '' };
  }
  evento.waitUntil(mostrar(aviso));
});

self.addEventListener('message', (evento) => {
  const dados = evento.data || {};
  if (dados.tipo === 'aviso') evento.waitUntil(mostrar(dados.aviso));
});

/* Clique na notificação: traz a aba já aberta para a frente na tela do
   processo; se não houver nenhuma, abre uma. */
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = (evento.notification.data && evento.notification.data.url) || '/avisos';

  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if ('focus' in janela) {
          janela.focus();
          if ('navigate' in janela) return janela.navigate(destino).catch(() => undefined);
          return undefined;
        }
      }
      return self.clients.openWindow(destino);
    })
  );
});

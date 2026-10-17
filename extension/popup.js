'use strict';

const $ = (id) => document.getElementById(id);

chrome.runtime.sendMessage({ type: 'status' }, (status) => {
  $('enabled').checked = status.enabled;
  $('dot').classList.toggle('on', status.connected);
  $('status').textContent = status.connected ? 'Conectado ao app' : 'App não está aberto';
  if (!status.connected) {
    $('hint').textContent = 'Abra o Meu Downloader. Enquanto ele estiver fechado, o navegador baixa normalmente.';
  } else if (!status.config.captureEnabled) {
    $('hint').textContent = 'A captura está desligada nas configurações do app.';
  } else {
    $('hint').textContent = `Tipos capturados: ${status.config.captureExtensions.length}. Clique com o botão direito em um link para baixar qualquer arquivo.`;
  }
});

$('enabled').addEventListener('change', (event) => {
  chrome.storage.local.set({ enabled: event.target.checked });
});

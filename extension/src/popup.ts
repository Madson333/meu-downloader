import type { StatusReply } from './background';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
}

const enabledBox = $<HTMLInputElement>('enabled');

chrome.runtime.sendMessage({ type: 'status' }, (status: StatusReply) => {
  enabledBox.checked = status.enabled;
  $('dot').classList.toggle('on', status.connected);
  $('status').textContent = status.connected ? 'Conectado ao app' : 'App não está aberto';
  if (!status.connected || !status.config) {
    $('hint').textContent = 'Abra o Meu Downloader. Enquanto ele estiver fechado, o navegador baixa normalmente.';
  } else if (!status.config.captureEnabled) {
    $('hint').textContent = 'A captura está desligada nas configurações do app.';
  } else {
    $('hint').textContent = `Tipos capturados: ${status.config.captureExtensions.length}. Clique com o botão direito em um link para baixar qualquer arquivo.`;
  }
});

enabledBox.addEventListener('change', () => {
  void chrome.storage.local.set({ enabled: enabledBox.checked });
});

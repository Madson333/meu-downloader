// window.downloader is exposed by src/main/preload.ts.
interface Window {
  downloader: import('../shared/api').DownloaderApi;
}

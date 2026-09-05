import { createSearchRuntime, type SearchCommand } from './search-protocol';

const runtime = createSearchRuntime((response) => self.postMessage(response));
self.onmessage = (event: MessageEvent<SearchCommand>) => {
  void runtime.handle(event.data);
};

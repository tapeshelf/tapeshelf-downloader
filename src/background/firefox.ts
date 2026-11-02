/**
 * The Firefox build's background page: the service worker's part and the offscreen
 * document's part in one page — Firefox has no offscreen document, and its background page has
 * the DOM, the workers and the storage the queue's work needs.
 */
import './index';
import '../offscreen/index';

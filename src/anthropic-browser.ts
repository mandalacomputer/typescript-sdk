import {
  BetaAbstractBrowserToolset20260801,
  type BetaBrowserToolsetOptions,
  type BetaToolsetCallContext,
  ToolError,
} from '@anthropic-ai/sdk/helpers/beta/toolsets';
import type * as Beta from '@anthropic-ai/sdk/resources/beta';
import { BrowserCDP, BrowserDriverError } from './browser-cdp.js';
import type { Computer } from './computer.js';

/** Browser state is owned by the driver. Remote file transfer is not supported. */
export type MandalaBrowserToolsetOptions = Omit<
  BetaBrowserToolsetOptions,
  'browserState' | 'filePolicy'
>;

/** An isolated, ten-minute Chromium context on a running Mandala computer.
 *
 * The URL policy checks navigation and intercepted HTTP(S) requests. It is not
 * network isolation: configure guest egress controls for that. Popups, workers,
 * cross-process frames, uploads and downloads are unsupported. JavaScript
 * execution is off by default and requires confirm when enabled.
 */
export class MandalaBrowserToolset extends BetaAbstractBrowserToolset20260801 {
  readonly #backend: BrowserCDP;

  constructor(computer: Computer, options: MandalaBrowserToolsetOptions = {}) {
    const backend = new BrowserCDP(
      () => computer.createBrowserConnection(),
      (id) => computer.revokeBrowserConnection(id),
      async (tabId, url) => {
        if (options.urlPolicy) {
          const result: unknown = await options.urlPolicy({ tabId }, url);
          if (result !== undefined)
            throw new BrowserDriverError(
              'URL policy must allow with no return value or refuse by throwing.',
            );
        }
      },
    );
    super({ ...options, browserState: () => backend.state() });
    this.#backend = backend;
  }

  async #call<T>(ctx: BetaToolsetCallContext, name: string, input: object): Promise<T> {
    ctx.signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.#backend.perform(name, input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Browser action deadline exceeded')), 45000);
          abort = () => reject(new Error('Browser action interrupted'));
          ctx.signal?.addEventListener('abort', abort, { once: true });
          if (ctx.signal?.aborted) abort();
        }),
      ]);
      ctx.signal?.throwIfAborted();
      return result as T;
    } catch (error) {
      if (!(error instanceof BrowserDriverError) || ctx.signal?.aborted) {
        try {
          await this.#backend.close();
        } catch {
          /* The disconnected grant expires within ten minutes. */
        }
      }
      ctx.signal?.throwIfAborted();
      throw new ToolError(
        error instanceof BrowserDriverError
          ? error.message
          : 'Browser action failed and the session was closed. Create a new toolset to continue.',
      );
    } finally {
      clearTimeout(timer);
      if (abort) ctx.signal?.removeEventListener('abort', abort);
    }
  }

  override async close(): Promise<void> {
    await super.close();
    try {
      await this.#backend.close();
    } catch {
      throw new ToolError(
        'Browser disconnected, but its grant could not be revoked; it expires within ten minutes.',
      );
    }
  }

  protected override navigate(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserNavigateInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['navigate']> {
    return this.#call(ctx, 'navigate', input);
  }

  protected override screenshot(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserScreenshotInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['screenshot']> {
    return this.#call(ctx, 'screenshot', input);
  }

  protected override zoom(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserZoomInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['zoom']> {
    return this.#call(ctx, 'zoom', input);
  }

  protected override left_click(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserLeftClickInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['left_click']> {
    return this.#call(ctx, 'left_click', input);
  }

  protected override right_click(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserRightClickInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['right_click']> {
    return this.#call(ctx, 'right_click', input);
  }

  protected override middle_click(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserMiddleClickInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['middle_click']> {
    return this.#call(ctx, 'middle_click', input);
  }

  protected override double_click(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserDoubleClickInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['double_click']> {
    return this.#call(ctx, 'double_click', input);
  }

  protected override triple_click(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserTripleClickInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['triple_click']> {
    return this.#call(ctx, 'triple_click', input);
  }

  protected override hover(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserHoverInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['hover']> {
    return this.#call(ctx, 'hover', input);
  }

  protected override left_click_drag(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserLeftClickDragInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['left_click_drag']> {
    return this.#call(ctx, 'left_click_drag', input);
  }

  protected override left_mouse_down(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserLeftMouseDownInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['left_mouse_down']> {
    return this.#call(ctx, 'left_mouse_down', input);
  }

  protected override left_mouse_up(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserLeftMouseUpInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['left_mouse_up']> {
    return this.#call(ctx, 'left_mouse_up', input);
  }

  protected override mouse_move(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserMouseMoveInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['mouse_move']> {
    return this.#call(ctx, 'mouse_move', input);
  }

  protected override scroll(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserScrollInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['scroll']> {
    return this.#call(ctx, 'scroll', input);
  }

  protected override scroll_to(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserScrollToInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['scroll_to']> {
    return this.#call(ctx, 'scroll_to', input);
  }

  protected override type_(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserTypeInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['type_']> {
    return this.#call(ctx, 'type', input);
  }

  protected override key(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserKeyInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['key']> {
    return this.#call(ctx, 'key', input);
  }

  protected override hold_key(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserHoldKeyInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['hold_key']> {
    return this.#call(ctx, 'hold_key', input);
  }

  protected override form_input(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserFormInputInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['form_input']> {
    return this.#call(ctx, 'form_input', input);
  }

  protected override read_page(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserReadPageInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['read_page']> {
    return this.#call(ctx, 'read_page', input);
  }

  protected override find(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserFindInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['find']> {
    return this.#call(ctx, 'find', input);
  }

  protected override get_page_text(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserGetPageTextInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['get_page_text']> {
    return this.#call(ctx, 'get_page_text', input);
  }

  protected override wait(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserWaitInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['wait']> {
    return this.#call(ctx, 'wait', input);
  }

  protected override read_console(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserReadConsoleInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['read_console']> {
    return this.#call(ctx, 'read_console', input);
  }

  protected override read_network(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserReadNetworkInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['read_network']> {
    return this.#call(ctx, 'read_network', input);
  }

  protected override javascript_exec(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserJavascriptExecInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['javascript_exec']> {
    return this.#call(ctx, 'javascript_exec', input);
  }

  protected override new_tab(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserNewTabInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['new_tab']> {
    return this.#call(ctx, 'new_tab', input);
  }

  protected override list_tabs(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserListTabsInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['list_tabs']> {
    return this.#call(ctx, 'list_tabs', input);
  }

  protected override switch_tab(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserSwitchTabInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['switch_tab']> {
    return this.#call(ctx, 'switch_tab', input);
  }

  protected override close_tab(
    ctx: BetaToolsetCallContext,
    input: Beta.BetaBrowserCloseTabInput,
  ): ReturnType<BetaAbstractBrowserToolset20260801['close_tab']> {
    return this.#call(ctx, 'close_tab', input);
  }
}

'use strict';
(() => {
  let token = '';
  let offset = 0;
  let session = 0;
  let loading = false;
  let actionBusy = false;
  const readyAwaitingRefresh = new Set();
  const $ = id => document.getElementById(id);
  const paymentLabels = {
    pending: 'Payment pending', authorized: 'Payment authorized, not collected',
    partially_paid: 'Partially paid', paid: 'Paid in full', partially_refunded: 'Partially refunded',
    refunded: 'Fully refunded', voided: 'Payment voided', expired: 'Payment authorization expired', unknown: 'Payment needs review'
  };
  const holdLabels = {
    test_order: 'Test order — do not cut', cancelled: 'Cancelled — do not cut', refund_review: 'Refund needs review',
    payment_not_paid: 'Payment is not complete', snapshot_invalid: 'Saved order details need review',
    checkout_metadata_invalid: 'Saved checkout details need review', order_reference_mismatch: 'Order reference has changed',
    currency_mismatch: 'Order currency has changed', tax_settings_mismatch: 'Tax settings have changed',
    test_status_missing: 'Test payment status needs review', discount_mismatch: 'Order discount needs review',
    cut_lines_mismatch: 'Cut details or quantities have changed', price_mismatch: 'Cut price has changed',
    subtotal_mismatch: 'Order subtotal has changed', delivery_price_mismatch: 'Pickup or delivery price has changed',
    fulfillment_address_mismatch: 'Pickup or delivery address has changed', order_total_mismatch: 'Order total has changed',
    outstanding_balance: 'There is an unpaid balance', event_timestamp_invalid: 'Order update time needs review'
  };
  const notificationLabels = {
    queued: 'Queued — waiting to send.',
    sending: 'Sending — waiting for the email server.',
    sent: 'Accepted by the email server. Delivery has not been confirmed.',
    failed: 'Email was not sent. Review is needed before another attempt.',
    needs_review: 'Needs review — the sending outcome is uncertain. Do not send another email.',
    cancelled: 'Cancelled before sending.'
  };
  function readable(value) { return String(value || 'Needs review').replaceAll('_', ' '); }
  function formatTime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-CA', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto'
    }).format(date) : '';
  }
  function signOut(message = 'Signed out. The access key and orders have been cleared from this page.') {
    session += 1;
    token = '';
    offset = 0;
    loading = false;
    actionBusy = false;
    readyAwaitingRefresh.clear();
    $('staff-key').value = '';
    $('staff-orders').replaceChildren();
    $('staff-controls').hidden = true;
    $('staff-login').hidden = false;
    $('staff-previous').hidden = true;
    $('staff-next').hidden = true;
    $('staff-status').textContent = message;
    $('staff-email-status').textContent = '';
    $('staff-key').focus();
  }
  function setLoading(value) {
    loading = value;
    updateButtons();
  }
  function updateButtons() {
    for (const id of ['staff-refresh', 'staff-previous', 'staff-next']) $(id).disabled = loading || actionBusy;
    for (const button of $('staff-orders').querySelectorAll('[data-order-action]')) {
      button.disabled = loading || actionBusy || button.dataset.available !== 'true'
        || (button.dataset.orderAction === 'ready' && readyAwaitingRefresh.has(button.dataset.orderId));
    }
  }
  function orderButton(label, action, order, available) {
    const button = text('button', label);
    button.type = 'button';
    button.className = `button ${action === 'ready' ? 'button-primary' : 'button-secondary'}`;
    button.dataset.orderAction = action;
    button.dataset.orderId = order.id;
    button.dataset.available = String(available);
    button.disabled = !available;
    return button;
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {...options, headers:{'content-type':'application/json', authorization:`Bearer ${token}`}});
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'The request could not be completed.');
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result;
  }
  function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
  async function loadOrders(notice = '') {
    if (!token || loading) return;
    const currentSession = session;
    setLoading(true);
    $('staff-status').textContent = 'Loading orders…';
    try {
      const {orders, notification_connected} = await request(`/api/admin/orders?offset=${offset}`);
      if (currentSession !== session) return;
      $('staff-email-status').textContent = notification_connected === true
        ? 'Ready emails are connected. Use Refresh orders to check sending status.'
        : 'Email sending isn’t connected yet.';
      $('staff-orders').replaceChildren();
      $('staff-previous').hidden = offset === 0;
      $('staff-next').hidden = orders.length < 50;
      for (const order of orders) {
        readyAwaitingRefresh.delete(order.id);
        const card = document.createElement('article'); card.className = 'cart-item';
        const content = document.createElement('div');
        content.append(text('h2', `Shopify order ${order.shopify_order_id}`));
        if (typeof order.shop === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(order.shop)
          && /^[1-9]\d{0,29}$/.test(String(order.shopify_order_id))) {
          const link = text('a', 'Open order in Shopify');
          link.href = `https://${order.shop}/admin/orders/${order.shopify_order_id}`;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          content.append(link);
        }
        content.append(text('p', `${paymentLabels[order.payment_status] || readable(order.payment_status)} · ${order.is_cut ? 'Entire order cut' : 'Not cut'}`));
        if (order.cancelled_at) content.append(text('p', 'Cancelled — do not cut or deliver.'));
        if (order.refunded) content.append(text('p', 'Refund recorded — review the amount and remaining order in Shopify.'));
        if (order.hold_reason) content.append(text('p', `On hold: ${holdLabels[order.hold_reason] || readable(order.hold_reason)}.`));
        for (const cut of order.cuts) {
          const size = cut.shape === 'circle' ? `${cut.widthUnits / 10000} mm diameter`
            : `${cut.widthUnits / 10000} × ${cut.heightUnits / 10000} mm`;
          content.append(text('p', `${cut.quantity} × ${cut.sheetId} ${cut.shape}, ${size}`));
        }
        const blocked = order.payment_status !== 'paid' || !!order.hold_reason || order.refunded || !!order.cancelled_at;
        const button = orderButton(order.is_cut ? 'Reopen cutting status' : 'Mark entire order cut', 'cut', order, order.is_cut || !blocked);
        button.addEventListener('click', async () => {
          if (currentSession !== session || !token || loading || actionBusy || button.disabled) return;
          const reason = order.is_cut ? window.prompt('Why is this order being reopened?') : '';
          if (order.is_cut && !reason?.trim()) return;
          actionBusy = true;
          updateButtons();
          try {
            await request(`/api/admin/orders/${order.id}/cut`, {method:'PATCH',body:JSON.stringify({isCut:!order.is_cut,expectedRevision:order.revision,reason})});
            if (currentSession === session) await loadOrders();
          } catch(error) {
            if (currentSession !== session) return;
            if (error.status === 401 || error.status === 403) signOut('Access was not accepted. Sign in again to load orders.');
            else await loadOrders(error.message);
          } finally {
            if (currentSession === session) { actionBusy = false; updateButtons(); }
          }
        });
        const readyLabel = order.fulfillment === 'pickup' ? 'Ready for pickup'
          : order.fulfillment === 'delivery' ? 'Ready for drop-off' : 'Ready';
        content.append(text('p', order.ready_at
          ? `${readyLabel} · ${formatTime(order.ready_at)} (Toronto time)`
          : 'Not marked ready.'));
        if (order.latest_notification) {
          const notification = order.latest_notification;
          const previous = !order.ready_at || notification.generation !== order.ready_generation;
          const status = notificationLabels[notification.state] || 'Status needs review. Do not send another email.';
          content.append(text('p', `${previous ? 'Previous ready email' : 'Ready email'}: ${status}`));
          if (notification.sent_at) content.append(text('p', `Accepted ${formatTime(notification.sent_at)} (Toronto time).`));
        }
        const readyAvailable = notification_connected === true && order.ready_eligible === true
          && order.is_cut && !blocked && ['pickup', 'delivery'].includes(order.fulfillment);
        const readyButton = orderButton(`${readyLabel} — email customer`, 'ready', order, readyAvailable);
        if (!readyAvailable) {
          const explanation = notification_connected !== true ? 'Email sending isn’t connected yet.'
            : order.ready_block_reason || (blocked ? 'Resolve the order hold or payment issue before marking it ready.'
              : !order.is_cut ? 'Mark the whole order cut before marking it ready.' : 'This order needs review before marking it ready.');
          const reason = text('p', explanation);
          reason.id = `ready-reason-${order.id}`;
          readyButton.setAttribute('aria-describedby', reason.id);
          content.append(reason);
        }
        readyButton.addEventListener('click', async () => {
          if (currentSession !== session || !token || loading || actionBusy || readyButton.disabled) return;
          actionBusy = true;
          readyAwaitingRefresh.add(order.id);
          updateButtons();
          $('staff-status').textContent = `Marking order ${order.shopify_order_id} ready and queuing its email…`;
          try {
            const result = await request(`/api/admin/orders/${order.id}/ready`, {
              method: 'POST', body: JSON.stringify({ expectedRevision: order.revision })
            });
            if (currentSession !== session) return;
            await loadOrders(result.reused
              ? 'This Ready action was already recorded. No second email was queued.'
              : 'Order marked ready. Check its email status below; use Refresh orders for updates.');
          } catch (error) {
            if (currentSession !== session) return;
            if (error.status === 401 || error.status === 403) signOut('Access was not accepted. Sign in again to load orders.');
            else {
              await loadOrders(error.status ? error.message
                : 'The Ready request was not confirmed. Check the refreshed email status before trying again.');
            }
          } finally {
            if (currentSession === session) { actionBusy = false; updateButtons(); }
          }
        });
        const actions = document.createElement('div');
        actions.className = 'cart-item-bottom';
        actions.append(button, readyButton);
        content.append(actions); card.append(content); $('staff-orders').append(card);
      }
      $('staff-status').textContent = notice || (orders.length ? `${orders.length} orders on this page. Refresh before cutting or marking ready.` : 'No orders yet.');
    } catch(error) {
      if (currentSession !== session) return;
      if (error.status === 401 || error.status === 403) signOut('Access was not accepted. Sign in again to load orders.');
      else $('staff-status').textContent = notice
        ? `${notice} The order list could not be refreshed. Use Refresh orders before another action.` : error.message;
    } finally {
      if (currentSession === session) setLoading(false);
    }
  }
  $('staff-previous').addEventListener('click', () => {if (!loading) {offset=Math.max(0,offset-50);loadOrders();}});
  $('staff-next').addEventListener('click', () => {if (!loading) {offset+=50;loadOrders();}});
  $('staff-refresh').addEventListener('click', () => loadOrders());
  $('staff-signout').addEventListener('click', () => signOut());
  $('staff-login').addEventListener('submit', event => {
    event.preventDefault();
    session += 1;
    token = $('staff-key').value;
    offset = 0;
    loading = false;
    $('staff-key').value = '';
    $('staff-login').hidden = true;
    $('staff-controls').hidden = false;
    loadOrders();
  });
})();

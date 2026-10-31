'use strict';
(() => {
  let token = '';
  let offset = 0;
  let session = 0;
  let loading = false;
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
  function readable(value) { return String(value || 'Needs review').replaceAll('_', ' '); }
  function signOut(message = 'Signed out. The access key and orders have been cleared from this page.') {
    session += 1;
    token = '';
    offset = 0;
    loading = false;
    $('staff-key').value = '';
    $('staff-orders').replaceChildren();
    $('staff-controls').hidden = true;
    $('staff-login').hidden = false;
    $('staff-previous').hidden = true;
    $('staff-next').hidden = true;
    $('staff-status').textContent = message;
    $('staff-key').focus();
  }
  function setLoading(value) {
    loading = value;
    for (const id of ['staff-refresh', 'staff-previous', 'staff-next']) $(id).disabled = value;
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {...options, headers:{'content-type':'application/json', authorization:`Bearer ${token}`}});
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
  async function loadOrders() {
    if (!token || loading) return;
    const currentSession = session;
    setLoading(true);
    $('staff-status').textContent = 'Loading orders…';
    try {
      const {orders} = await request(`/api/admin/orders?offset=${offset}`);
      if (currentSession !== session) return;
      $('staff-orders').replaceChildren();
      $('staff-previous').hidden = offset === 0;
      $('staff-next').hidden = orders.length < 50;
      for (const order of orders) {
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
        const button = text('button', order.is_cut ? 'Reopen cutting status' : 'Mark entire order cut'); button.className = 'button button-secondary';
        button.disabled = !order.is_cut && (order.payment_status !== 'paid' || !!order.hold_reason || order.refunded || !!order.cancelled_at);
        button.addEventListener('click', async () => {
          if (currentSession !== session || !token) return;
          const reason = order.is_cut ? window.prompt('Why is this order being reopened?') : '';
          if (order.is_cut && !reason?.trim()) return;
          button.disabled = true;
          try {
            await request(`/api/admin/orders/${order.id}/cut`, {method:'PATCH',body:JSON.stringify({isCut:!order.is_cut,expectedRevision:order.revision,reason})});
            if (currentSession === session) await loadOrders();
          } catch(error) {
            if (currentSession !== session) return;
            if (error.status === 401 || error.status === 403) signOut('Access was not accepted. Sign in again to load orders.');
            else { $('staff-status').textContent = error.message; button.disabled = false; }
          }
        });
        content.append(button); card.append(content); $('staff-orders').append(card);
      }
      $('staff-status').textContent = orders.length ? `${orders.length} orders on this page. Refresh before cutting.` : 'No orders yet.';
    } catch(error) {
      if (currentSession !== session) return;
      if (error.status === 401 || error.status === 403) signOut('Access was not accepted. Sign in again to load orders.');
      else $('staff-status').textContent = error.message;
    } finally {
      if (currentSession === session) setLoading(false);
    }
  }
  $('staff-previous').addEventListener('click', () => {if (!loading) {offset=Math.max(0,offset-50);loadOrders();}});
  $('staff-next').addEventListener('click', () => {if (!loading) {offset+=50;loadOrders();}});
  $('staff-refresh').addEventListener('click', loadOrders);
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

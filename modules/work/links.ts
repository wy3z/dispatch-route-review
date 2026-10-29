/** Read-only ticket URL; absent configuration and invalid IDs suppress links. */
export function autotaskTicketUrl(ticketId: number | null | undefined, webUrl: string | null = null) {
  return webUrl && typeof ticketId === "number" && Number.isSafeInteger(ticketId) && ticketId > 0
    ? `${webUrl}/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=${ticketId}`
    : null;
}

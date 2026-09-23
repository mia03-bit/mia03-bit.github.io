import { useState } from "react";

export const DEFAULT_PAGE_SIZE = 10;

export function usePagination<T>(items: T[], resetKey = "", pageSize = DEFAULT_PAGE_SIZE) {
  const [pagination, setPagination] = useState({ resetKey, page: 1 });
  const requestedPage = pagination.resetKey === resetKey ? pagination.page : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const startIndex = (page - 1) * pageSize;
  const setPage = (nextPage: number) => setPagination({ resetKey, page: nextPage });

  return {
    page,
    pageItems: items.slice(startIndex, startIndex + pageSize),
    pageSize,
    setPage,
    totalItems: items.length,
    totalPages,
  };
}

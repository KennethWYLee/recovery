type Envelope<T> = { data?: T; error?: { message?: string } };

export async function classroomApiData<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || body?.data === undefined) {
    throw new Error(body?.error?.message ?? "目前無法處理課堂資料。");
  }
  return body.data;
}

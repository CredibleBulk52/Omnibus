import { pageContext } from './AssistantBubble';

test('page context: editors, Essential pages and the newer pages get their own guide', () => {
  expect(pageContext('/essentials/12')).toEqual({ page: 'reading_list', listId: '12' });
  expect(pageContext('/reading-lists/7')).toEqual({ page: 'reading_list', listId: '7' });
  expect(pageContext('/essentials/12/edit')).toEqual({ page: 'editor', kind: 'list', id: '12' });
  expect(pageContext('/reading-lists/7/edit')).toEqual({ page: 'editor', kind: 'list', id: '7' });
  expect(pageContext('/events/zh-1994/edit')).toEqual({ page: 'editor', kind: 'event', id: 'zh-1994' });
  expect(pageContext('/canon/run/5/edit')).toEqual({ page: 'editor', kind: 'run', id: '5' });
  expect(pageContext('/events/zh-1994')).toEqual({ page: 'event', eventId: 'zh-1994' });
  expect(pageContext('/canon/run/5')).toEqual({ page: 'canon_run', runId: '5' });
  expect(pageContext('/my-requests')).toEqual({ page: 'my_requests' });
  expect(pageContext('/appearance')).toEqual({ page: 'appearance' });
  expect(pageContext('/downloads')).toEqual({ page: 'other', label: 'Downloads' });
});

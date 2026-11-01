export interface Post {
  id: string;
  title: string;
}

const posts = new Map<string, Post>([["1", { id: "1", title: "Hello" }]]);

export const listPosts = (): Post[] => [...posts.values()];
export const getPost = (id: string): Post | undefined => posts.get(id);

export function savePost(post: Post): Post {
  posts.set(post.id, post);
  return post;
}

export const removePost = (id: string): boolean => posts.delete(id);

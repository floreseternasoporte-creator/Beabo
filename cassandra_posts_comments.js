const cassandra = require('cassandra-driver');

const client = new cassandra.Client({
  contactPoints: [
    'node-0.gce-us-east-1.5246022d128c1a307e14.clusters.scylla.cloud',
    'node-1.gce-us-east-1.5246022d128c1a307e14.clusters.scylla.cloud',
    'node-2.gce-us-east-1.5246022d128c1a307e14.clusters.scylla.cloud'
  ],
  localDataCenter: 'GCE_US_EAST_1',
  credentials: { username: 'scylla', password: 'X6uZvPj83KIdtJS' }
  // keyspace: 'your_keyspace'
});

async function connect() {
  await client.connect();
  const results = await client.execute('SELECT * FROM system.clients LIMIT 10');
  results.rows.forEach((row) => console.log(JSON.stringify(row)));
  return client;
}

async function getPosts(limit = 50) {
  const query = 'SELECT * FROM posts LIMIT ?';
  const result = await client.execute(query, [limit], { prepare: true });
  return result.rows;
}

async function getCommentsByPost(postId, limit = 100) {
  const query = 'SELECT * FROM comments WHERE post_id = ? LIMIT ?';
  const result = await client.execute(query, [postId, limit], { prepare: true });
  return result.rows;
}

async function savePost(post) {
  const query = `
    INSERT INTO posts (id, author_id, content, created_at)
    VALUES (?, ?, ?, ?)
  `;
  await client.execute(query, [post.id, post.author_id, post.content, post.created_at], { prepare: true });
}

async function saveComment(comment) {
  const query = `
    INSERT INTO comments (post_id, id, author_id, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `;
  await client.execute(
    query,
    [comment.post_id, comment.id, comment.author_id, comment.content, comment.created_at],
    { prepare: true }
  );
}

async function shutdown() {
  await client.shutdown();
}

module.exports = {
  client,
  connect,
  getPosts,
  getCommentsByPost,
  savePost,
  saveComment,
  shutdown
};

if (require.main === module) {
  connect()
    .then(async () => {
      console.log('Conexión a Scylla/Cassandra lista para posts y comentarios.');
      await shutdown();
    })
    .catch(async (error) => {
      console.error('Error conectando a Cassandra:', error);
      try { await shutdown(); } catch (_) {}
      process.exit(1);
    });
}

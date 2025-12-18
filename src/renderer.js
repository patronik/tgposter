async function load() {
  const items = await window.api.getItems();
  const list = document.getElementById('list');
  list.innerHTML = '';

  items.forEach(i => {
    const li = document.createElement('li');
    li.innerHTML = `
      ${i.id} ${i.comment} ${i.reaction}
      <button onclick="edit('${i.id}')">Edit</button>
      <button onclick="remove('${i.id}')">Delete</button>
    `;
    list.appendChild(li);
  });
}

async function add() {
  const id = document.getElementById('id').value;
  const comment = document.getElementById('comment').value;
  const reaction = document.getElementById('reaction').value;

  await window.api.addItem({
    id,
    comment,
    reaction
  });

  load();
}

async function edit(id) {
  const comment = prompt('New comment');
  const reaction = prompt('New reaction');

  await window.api.updateItem({ id, comment, reaction });
  load();
}

async function remove(id) {
  await window.api.deleteItem(id);
  load();
}

load();

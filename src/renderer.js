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
  const item = await window.api.getItem(id);
  if (item) {
    return;
  }

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
  const item = await window.api.getItem(id);

  document.getElementById('id').value = item.id;
  document.getElementById('comment').value = item.comment;
  document.getElementById('reaction').value = item.reaction;

  document.getElementById("add_btn").style.display = "none";
  document.getElementById("save_btn").style.display = "block";
  document.getElementById("id").readOnly = true;
}

async function save() {
  const id = document.getElementById('id').value;
  const comment = document.getElementById('comment').value;
  const reaction = document.getElementById('reaction').value;

  await window.api.updateItem({ id, comment, reaction });
  load();

  document.getElementById('id').value = '';
  document.getElementById('comment').value = '';
  document.getElementById('reaction').value = '';

  document.getElementById("add_btn").style.display = "block";
  document.getElementById("save_btn").style.display = "none";
  document.getElementById("id").readOnly = false;
}

async function remove(id) {
  await window.api.deleteItem(id);
  load();
}

load();

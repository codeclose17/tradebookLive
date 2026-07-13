import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-file-uploader',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div 
      class="upload-container" 
      [class.drag-over]="isDragging"
      (dragover)="onDragOver($event)" 
      (dragleave)="onDragLeave($event)" 
      (drop)="onDrop($event)"
      (click)="fileInput.click()">
      
      <input 
        #fileInput 
        type="file" 
        accept=".xlsx, .xls" 
        (change)="onFileSelected($event)" 
        hidden>
      
      <div class="upload-content">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="upload-icon">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <h3>Upload Tradebook</h3>
        <p>Drag & drop your Zerodha Excel file here</p>
        <button class="upload-btn">Browse File</button>
      </div>
    </div>
  `,
  styleUrls: ['./file-uploader.component.css']
})
export class FileUploaderComponent {
  @Output() fileLoaded = new EventEmitter<ArrayBuffer>();
  
  isDragging = false;

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragging = true;
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    this.isDragging = false;
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.isDragging = false;
    
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      this.readFile(event.dataTransfer.files[0]);
    }
  }

  onFileSelected(event: any) {
    const file: File = event.target.files[0];
    if (file) {
      this.readFile(file);
    }
  }

  private readFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e: any) => {
      this.fileLoaded.emit(e.target.result);
    };
    reader.readAsArrayBuffer(file);
  }
}
